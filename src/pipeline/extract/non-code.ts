import { basename, dirname, extname, resolve } from 'node:path'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'

import type { ExtractionEdge, ExtractionNode } from './contracts.js'
import { appendDerivedProvenance, deriveIngestProvenanceFromRecord } from '../../core/provenance/ingest.js'
import type { ExtractionProvenance } from '../../core/provenance/types.js'
import { readBinaryIngestSidecar } from '../../shared/binary-ingest-sidecar.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../../shared/security.js'
import { FileType, classifyFile } from '../detect.js'
import {
  extractCompareBaselineDocxText as extractCompareBaselineDocxTextModule,
  extractCompareBaselineXlsxText as extractCompareBaselineXlsxTextModule,
  extractDocxDocument as extractDocxDocumentModule,
  extractStructuredText as extractStructuredTextModule,
  extractXlsxDocument as extractXlsxDocumentModule,
} from './non-code/document.js'
import {
  extractCompareBaselinePdfText as extractCompareBaselinePdfTextModule,
  extractPdfPaper as extractPdfPaperModule,
} from './non-code/pdf.js'
import { _makeId, addEdge, addNode, addUniqueEdge, createEdge, createFileNode, createNode, fileNodeIdForPath, fileStemForPath, normalizeLabel } from './core.js'

const BASELINE_TEXT_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

interface ProvenanceBearingRecord {
  provenance?: ExtractionProvenance[]
}

function createBinaryMetadataAwareFileNode(filePath: string, fileType: NonCodeFileType): ExtractionNode {
  const sidecarMetadata = readBinaryIngestSidecar(filePath)
  const extension = extname(filePath).toLowerCase()
  const contentType = BINARY_CONTENT_TYPES.get(extension)
  let fileBytes: number | undefined
  try {
    fileBytes = statSync(filePath).size
  } catch {
    fileBytes = undefined
  }
  const derivedMetadata = {
    ...(Number.isFinite(fileBytes) ? { file_bytes: fileBytes } : {}),
    ...(contentType ? { content_type: contentType } : {}),
    ...extractBinaryDurationMetadata(filePath, extension, fileType, fileBytes),
    ...extractBinaryTrackMetadata(filePath, extension, fileType, fileBytes),
    ...extractBinaryAudioMetadata(filePath, extension, fileType, fileBytes),
    ...extractBinaryVideoMetadata(filePath, extension, fileType, fileBytes),
  }

  return sidecarMetadata
    ? { ...sidecarMetadata, ...derivedMetadata, ...createFileNode(filePath, fileType) }
    : { ...derivedMetadata, ...createFileNode(filePath, fileType) }
}

function roundDurationSeconds(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function readFileWindow(filePath: string, position: number, byteLength: number): Buffer | null {
  if (byteLength <= 0) {
    return null
  }

  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, 'r')
    const buffer = Buffer.alloc(byteLength)
    const bytesRead = readSync(descriptor, buffer, 0, byteLength, position)
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore close failures for best-effort metadata reads.
      }
    }
  }
}

function extractWavDurationMetadata(filePath: string, fileBytes: number | undefined): Record<string, number> {
  if (!fileBytes || fileBytes < 44) {
    return {}
  }

  const header = readFileWindow(filePath, 0, Math.min(fileBytes, BINARY_METADATA_HEADER_BYTES))
  if (!header || header.length < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    return {}
  }

  let sampleRate: number | null = null
  let channelCount: number | null = null
  let byteRate: number | null = null
  let dataSize: number | null = null
  let dataOffsetInFile: number | null = null
  let offset = 12

  while (offset + 8 <= header.length) {
    const chunkSize = header.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const chunkId = header.toString('ascii', offset, offset + 4)

    if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= header.length) {
      channelCount = header.readUInt16LE(dataOffset + 2)
      sampleRate = header.readUInt32LE(dataOffset + 4)
      byteRate = header.readUInt32LE(dataOffset + 8)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      dataOffsetInFile = dataOffset
    }

    const nextOffset = dataOffset + chunkSize + (chunkSize % 2)
    if (nextOffset <= offset) {
      break
    }
    offset = nextOffset
  }

  const hasCompleteDataChunk =
    byteRate &&
    dataSize !== null &&
    dataOffsetInFile !== null &&
    byteRate > 0 &&
    dataOffsetInFile + dataSize <= fileBytes
  const durationSeconds = hasCompleteDataChunk && dataSize !== null && byteRate !== null
    ? roundDurationSeconds(dataSize / byteRate)
    : null

  return {
    ...(hasCompleteDataChunk && sampleRate ? { audio_sample_rate_hz: sampleRate } : {}),
    ...(hasCompleteDataChunk && channelCount ? { audio_channel_count: channelCount } : {}),
    ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
  }
}

interface RiffChunkHeader {
  startOffset: number
  id: string
  bodyOffset: number
  dataEndOffset: number
  endOffset: number
}

interface AviMainHeaderMetadata {
  durationSeconds: number | null
  width: number | null
  height: number | null
}

interface AviStreamHeaderMetadata {
  streamType: string
  durationSeconds: number | null
}

function readRiffChunkHeader(buffer: Buffer, offset: number, limit: number): RiffChunkHeader | null {
  if (offset + 8 > limit) {
    return null
  }

  const chunkSize = buffer.readUInt32LE(offset + 4)
  const bodyOffset = offset + 8
  const dataEndOffset = bodyOffset + chunkSize
  if (dataEndOffset > limit) {
    return null
  }

  const endOffset = dataEndOffset + (chunkSize % 2)
  if (endOffset > limit) {
    return null
  }

  return {
    startOffset: offset,
    id: buffer.toString('ascii', offset, offset + 4),
    bodyOffset,
    dataEndOffset,
    endOffset,
  }
}

function readRiffFormHeader(buffer: Buffer, fileBytes: number): RiffChunkHeader | null {
  if (buffer.length < 8 || fileBytes < 8) {
    return null
  }

  const chunkSize = buffer.readUInt32LE(4)
  const bodyOffset = 8
  const fullDataEndOffset = bodyOffset + chunkSize
  if (fullDataEndOffset > fileBytes) {
    return null
  }

  const fullEndOffset = fullDataEndOffset + (chunkSize % 2)
  if (fullEndOffset > fileBytes) {
    return null
  }

  return {
    startOffset: 0,
    id: buffer.toString('ascii', 0, 4),
    bodyOffset,
    dataEndOffset: Math.min(fullDataEndOffset, buffer.length),
    endOffset: Math.min(fullEndOffset, buffer.length),
  }
}

function readRiffListType(buffer: Buffer, chunk: RiffChunkHeader): string | null {
  if ((chunk.id !== 'RIFF' && chunk.id !== 'LIST') || chunk.bodyOffset + 4 > chunk.dataEndOffset) {
    return null
  }

  return buffer.toString('ascii', chunk.bodyOffset, chunk.bodyOffset + 4)
}

function findRiffListChunk(buffer: Buffer, parentChunk: RiffChunkHeader, listType: string): RiffChunkHeader | null {
  if ((parentChunk.id !== 'RIFF' && parentChunk.id !== 'LIST') || parentChunk.bodyOffset + 4 > parentChunk.dataEndOffset) {
    return null
  }

  let offset = parentChunk.bodyOffset + 4
  while (offset + 8 <= parentChunk.dataEndOffset) {
    const childChunk = readRiffChunkHeader(buffer, offset, parentChunk.dataEndOffset)
    if (!childChunk) {
      return null
    }

    if (childChunk.id === 'LIST' && readRiffListType(buffer, childChunk) === listType) {
      return childChunk
    }

    if (childChunk.endOffset <= offset) {
      return null
    }
    offset = childChunk.endOffset
  }

  return null
}

function parseAviMainHeader(buffer: Buffer, chunk: RiffChunkHeader): AviMainHeaderMetadata | null {
  if (chunk.bodyOffset + 40 > chunk.dataEndOffset) {
    return null
  }

  const microsecondsPerFrame = buffer.readUInt32LE(chunk.bodyOffset)
  const totalFrames = buffer.readUInt32LE(chunk.bodyOffset + 16)
  const width = buffer.readUInt32LE(chunk.bodyOffset + 32)
  const height = buffer.readUInt32LE(chunk.bodyOffset + 36)
  const durationSeconds =
    microsecondsPerFrame > 0 && totalFrames > 0
      ? roundDurationSeconds(Number(BigInt(microsecondsPerFrame) * BigInt(totalFrames)) / 1_000_000)
      : null

  return {
    durationSeconds,
    width: width > 0 && width <= 32_768 ? width : null,
    height: height > 0 && height <= 32_768 ? height : null,
  }
}

function parseAviStreamHeader(buffer: Buffer, chunk: RiffChunkHeader): AviStreamHeaderMetadata | null {
  if (chunk.bodyOffset + 36 > chunk.dataEndOffset) {
    return null
  }

  const streamType = buffer.toString('ascii', chunk.bodyOffset, chunk.bodyOffset + 4)
  const scale = buffer.readUInt32LE(chunk.bodyOffset + 20)
  const rate = buffer.readUInt32LE(chunk.bodyOffset + 24)
  const length = buffer.readUInt32LE(chunk.bodyOffset + 32)
  const durationSeconds =
    scale > 0 && rate > 0 && length > 0
      ? roundDurationSeconds(Number(BigInt(length) * BigInt(scale)) / rate)
      : null

  return { streamType, durationSeconds }
}

function parseAviBitmapInfoHeader(buffer: Buffer, chunk: RiffChunkHeader): { width: number; height: number } | null {
  if (chunk.bodyOffset + 12 > chunk.dataEndOffset) {
    return null
  }

  const width = buffer.readInt32LE(chunk.bodyOffset + 4)
  const height = Math.abs(buffer.readInt32LE(chunk.bodyOffset + 8))
  if (width <= 0 || width > 32_768 || height <= 0 || height > 32_768) {
    return null
  }

  return { width, height }
}

function parseAviWaveFormat(buffer: Buffer, chunk: RiffChunkHeader): { sampleRate: number; channelCount: number } | null {
  if (chunk.bodyOffset + 8 > chunk.dataEndOffset) {
    return null
  }

  const channelCount = buffer.readUInt16LE(chunk.bodyOffset + 2)
  const sampleRate = buffer.readUInt32LE(chunk.bodyOffset + 4)
  if (channelCount <= 0 || channelCount > 16 || sampleRate < 1_000 || sampleRate > 384_000) {
    return null
  }

  return { sampleRate, channelCount }
}

function parseAviVideoStreamListMetadata(
  buffer: Buffer,
  streamListChunk: RiffChunkHeader,
): { durationSeconds: number | null; width: number | null; height: number | null } | null {
  if (readRiffListType(buffer, streamListChunk) !== 'strl' || streamListChunk.bodyOffset + 4 > streamListChunk.dataEndOffset) {
    return null
  }

  let streamHeader: AviStreamHeaderMetadata | null = null
  let formatChunk: RiffChunkHeader | null = null
  let offset = streamListChunk.bodyOffset + 4
  while (offset + 8 <= streamListChunk.dataEndOffset) {
    const childChunk = readRiffChunkHeader(buffer, offset, streamListChunk.dataEndOffset)
    if (!childChunk) {
      break
    }

    if (childChunk.id === 'strh') {
      streamHeader = parseAviStreamHeader(buffer, childChunk)
    } else if (childChunk.id === 'strf' && !formatChunk) {
      formatChunk = childChunk
    }

    if (childChunk.endOffset <= offset) {
      break
    }
    offset = childChunk.endOffset
  }

  if (streamHeader?.streamType !== 'vids') {
    return null
  }

  const videoFormat = formatChunk ? parseAviBitmapInfoHeader(buffer, formatChunk) : null
  return {
    durationSeconds: streamHeader.durationSeconds,
    width: videoFormat?.width ?? null,
    height: videoFormat?.height ?? null,
  }
}

function parseAviAudioStreamListMetadata(
  buffer: Buffer,
  streamListChunk: RiffChunkHeader,
): { sampleRate: number | null; channelCount: number | null } | null {
  if (readRiffListType(buffer, streamListChunk) !== 'strl' || streamListChunk.bodyOffset + 4 > streamListChunk.dataEndOffset) {
    return null
  }

  let streamHeader: AviStreamHeaderMetadata | null = null
  let formatChunk: RiffChunkHeader | null = null
  let offset = streamListChunk.bodyOffset + 4
  while (offset + 8 <= streamListChunk.dataEndOffset) {
    const childChunk = readRiffChunkHeader(buffer, offset, streamListChunk.dataEndOffset)
    if (!childChunk) {
      break
    }

    if (childChunk.id === 'strh') {
      streamHeader = parseAviStreamHeader(buffer, childChunk)
    } else if (childChunk.id === 'strf' && !formatChunk) {
      formatChunk = childChunk
    }

    if (childChunk.endOffset <= offset) {
      break
    }
    offset = childChunk.endOffset
  }

  if (streamHeader?.streamType !== 'auds') {
    return null
  }

  const audioFormat = formatChunk ? parseAviWaveFormat(buffer, formatChunk) : null
  return {
    sampleRate: audioFormat?.sampleRate ?? null,
    channelCount: audioFormat?.channelCount ?? null,
  }
}

function extractAviVideoMetadata(filePath: string, fileBytes: number | undefined): Record<string, number> {
  if (!fileBytes || fileBytes < 12) {
    return {}
  }

  const head = readFileWindow(filePath, 0, Math.min(fileBytes, AVI_METADATA_SCAN_BYTES))
  if (!head || head.length < 12) {
    return {}
  }

  const riff = readRiffFormHeader(head, fileBytes)
  if (!riff || riff.id !== 'RIFF' || readRiffListType(head, riff) !== 'AVI ') {
    return {}
  }

  const headerList = findRiffListChunk(head, riff, 'hdrl')
  if (!headerList) {
    return {}
  }

  let mainHeader: AviMainHeaderMetadata | null = null
  let durationSeconds: number | null = null
  let width: number | null = null
  let height: number | null = null
  let audioSampleRate: number | null = null
  let audioChannelCount: number | null = null
  let offset = headerList.bodyOffset + 4
  while (offset + 8 <= headerList.dataEndOffset) {
    const childChunk = readRiffChunkHeader(head, offset, headerList.dataEndOffset)
    if (!childChunk) {
      break
    }

    if (childChunk.id === 'avih') {
      mainHeader = parseAviMainHeader(head, childChunk)
    } else if (childChunk.id === 'LIST' && readRiffListType(head, childChunk) === 'strl') {
      const videoStreamMetadata = parseAviVideoStreamListMetadata(head, childChunk)
      if (videoStreamMetadata) {
        if (durationSeconds === null && videoStreamMetadata.durationSeconds !== null) {
          durationSeconds = videoStreamMetadata.durationSeconds
        }
        if (width === null && videoStreamMetadata.width !== null) {
          width = videoStreamMetadata.width
        }
        if (height === null && videoStreamMetadata.height !== null) {
          height = videoStreamMetadata.height
        }
      }

      const audioStreamMetadata = parseAviAudioStreamListMetadata(head, childChunk)
      if (audioStreamMetadata) {
        if (audioSampleRate === null && audioStreamMetadata.sampleRate !== null) {
          audioSampleRate = audioStreamMetadata.sampleRate
        }
        if (audioChannelCount === null && audioStreamMetadata.channelCount !== null) {
          audioChannelCount = audioStreamMetadata.channelCount
        }
      }
    }

    if (childChunk.endOffset <= offset) {
      break
    }
    offset = childChunk.endOffset
  }

  const resolvedDuration = durationSeconds ?? mainHeader?.durationSeconds ?? null
  const resolvedWidth = width ?? mainHeader?.width ?? null
  const resolvedHeight = height ?? mainHeader?.height ?? null
  return {
    ...(resolvedDuration !== null ? { media_duration_seconds: resolvedDuration } : {}),
    ...(audioSampleRate ? { audio_sample_rate_hz: audioSampleRate } : {}),
    ...(audioChannelCount ? { audio_channel_count: audioChannelCount } : {}),
    ...(resolvedWidth ? { video_width_px: resolvedWidth } : {}),
    ...(resolvedHeight ? { video_height_px: resolvedHeight } : {}),
  }
}

interface Mp4BoxHeader {
  startOffset: number
  headerSize: number
  type: string
  bodyOffset: number
  endOffset: number
}

function readMp4BoxHeader(buffer: Buffer, offset: number, limit: number): Mp4BoxHeader | null {
  if (offset + 8 > limit) {
    return null
  }

  let size = buffer.readUInt32BE(offset)
  let headerBytes = 8
  if (size === 1) {
    if (offset + 16 > limit) {
      return null
    }

    const largeSize = buffer.readBigUInt64BE(offset + 8)
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    size = Number(largeSize)
    headerBytes = 16
  } else if (size === 0) {
    size = limit - offset
  }

  if (size < headerBytes || offset + size > limit) {
    return null
  }

  return {
    startOffset: offset,
    headerSize: headerBytes,
    type: buffer.toString('ascii', offset + 4, offset + 8),
    bodyOffset: offset + headerBytes,
    endOffset: offset + size,
  }
}

function readMp4BoxHeaderFromFile(filePath: string, offset: number, fileBytes: number): Mp4BoxHeader | null {
  const header = readFileWindow(filePath, offset, 16)
  if (!header || header.length < 8) {
    return null
  }

  let size = header.readUInt32BE(0)
  let headerSize = 8
  if (size === 1) {
    if (header.length < 16) {
      return null
    }

    const largeSize = header.readBigUInt64BE(8)
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    size = Number(largeSize)
    headerSize = 16
  } else if (size === 0) {
    size = fileBytes - offset
  }

  if (size < headerSize || offset + size > fileBytes) {
    return null
  }

  return {
    startOffset: offset,
    headerSize,
    type: header.toString('ascii', 4, 8),
    bodyOffset: offset + headerSize,
    endOffset: offset + size,
  }
}

function parseMvhdDurationSeconds(buffer: Buffer, box: Mp4BoxHeader): number | null {
  if (box.bodyOffset + 4 > box.endOffset) {
    return null
  }

  const version = buffer[box.bodyOffset]
  if (version === 0) {
    if (box.bodyOffset + 20 > box.endOffset) {
      return null
    }

    const timescale = buffer.readUInt32BE(box.bodyOffset + 12)
    const duration = buffer.readUInt32BE(box.bodyOffset + 16)
    return timescale > 0 ? roundDurationSeconds(duration / timescale) : null
  }

  if (version === 1) {
    if (box.bodyOffset + 32 > box.endOffset) {
      return null
    }

    const timescale = buffer.readUInt32BE(box.bodyOffset + 20)
    const duration = Number(buffer.readBigUInt64BE(box.bodyOffset + 24))
    return timescale > 0 && Number.isFinite(duration) ? roundDurationSeconds(duration / timescale) : null
  }

  return null
}

function parseMoovDurationSeconds(buffer: Buffer, moovBox: Mp4BoxHeader): number | null {
  let offset = moovBox.bodyOffset
  while (offset + 8 <= moovBox.endOffset) {
    const childBox = readMp4BoxHeader(buffer, offset, moovBox.endOffset)
    if (!childBox) {
      break
    }

    if (childBox.type === 'mvhd') {
      return parseMvhdDurationSeconds(buffer, childBox)
    }

    offset = childBox.endOffset
  }

  return null
}

function parseMdhdDurationSeconds(buffer: Buffer, box: Mp4BoxHeader): number | null {
  if (box.bodyOffset + 4 > box.endOffset) {
    return null
  }

  const version = buffer[box.bodyOffset]
  if (version === 0) {
    if (box.bodyOffset + 24 > box.endOffset) {
      return null
    }

    const timescale = buffer.readUInt32BE(box.bodyOffset + 12)
    const duration = buffer.readUInt32BE(box.bodyOffset + 16)
    return timescale > 0 ? roundDurationSeconds(duration / timescale) : null
  }

  if (version === 1) {
    if (box.bodyOffset + 36 > box.endOffset) {
      return null
    }

    const timescale = buffer.readUInt32BE(box.bodyOffset + 20)
    const duration = Number(buffer.readBigUInt64BE(box.bodyOffset + 24))
    return timescale > 0 && Number.isFinite(duration) ? roundDurationSeconds(duration / timescale) : null
  }

  return null
}

function findMp4ChildBox(buffer: Buffer, parentBox: Mp4BoxHeader, type: string, startOffset: number = parentBox.bodyOffset): Mp4BoxHeader | null {
  let offset = startOffset
  while (offset + 8 <= parentBox.endOffset) {
    const childBox = readMp4BoxHeader(buffer, offset, parentBox.endOffset)
    if (!childBox) {
      return null
    }
    if (childBox.type === type) {
      return childBox
    }
    if (childBox.endOffset <= offset) {
      return null
    }
    offset = childBox.endOffset
  }

  return null
}

function hasMp4FileSignature(buffer: Buffer): boolean {
  const box = readMp4BoxHeader(buffer, 0, buffer.length)
  return box?.type === 'ftyp'
}

function locateMp4MoovBox(filePath: string, fileBytes: number): Mp4BoxHeader | null {
  let offset = 0
  while (offset + 8 <= fileBytes) {
    const box = readMp4BoxHeaderFromFile(filePath, offset, fileBytes)
    if (!box) {
      return null
    }

    if (offset === 0 && box.type !== 'ftyp') {
      return null
    }

    if (box.type === 'moov') {
      return box
    }

    if (box.endOffset <= offset) {
      return null
    }
    offset = box.endOffset
  }

  return null
}

function readMp4MoovBuffer(filePath: string, fileBytes: number | undefined): { buffer: Buffer; moovBox: Mp4BoxHeader } | null {
  if (!fileBytes || fileBytes < 24) {
    return null
  }

  const windowSize = Math.min(fileBytes, MP4_DURATION_SCAN_BYTES)
  const head = readFileWindow(filePath, 0, windowSize)
  if (!head || !hasMp4FileSignature(head)) {
    return null
  }

  let offset = 0
  while (offset + 8 <= head.length) {
    const box = readMp4BoxHeader(head, offset, head.length)
    if (!box) {
      break
    }
    if (box.type === 'moov') {
      return { buffer: head, moovBox: box }
    }
    offset = box.endOffset
  }

  if (fileBytes <= windowSize) {
    return null
  }

  const moovBox = locateMp4MoovBox(filePath, fileBytes)
  if (!moovBox) {
    return null
  }

  const moovWindowSize = Math.min(moovBox.endOffset - moovBox.startOffset, MP4_DURATION_SCAN_BYTES)
  const moovBuffer = readFileWindow(filePath, moovBox.startOffset, moovWindowSize)
  if (!moovBuffer || moovBuffer.length <= moovBox.headerSize) {
    return null
  }

  return {
    buffer: moovBuffer,
    moovBox: {
      startOffset: 0,
      headerSize: moovBox.headerSize,
      type: 'moov',
      bodyOffset: moovBox.headerSize,
      endOffset: moovBuffer.length,
    },
  }
}

function parseMp4AudioSampleEntry(buffer: Buffer, sampleEntryBox: Mp4BoxHeader): { sampleRate: number; channelCount: number } | null {
  if (sampleEntryBox.bodyOffset + 28 > sampleEntryBox.endOffset) {
    return null
  }

  const channelCount = buffer.readUInt16BE(sampleEntryBox.bodyOffset + 16)
  const sampleRate = buffer.readUInt32BE(sampleEntryBox.bodyOffset + 24) >>> 16
  if (channelCount <= 0 || channelCount > 16 || sampleRate < 1_000 || sampleRate > 384_000) {
    return null
  }

  return { sampleRate, channelCount }
}

function parseMp4VisualSampleEntry(buffer: Buffer, sampleEntryBox: Mp4BoxHeader): { width: number; height: number } | null {
  if (sampleEntryBox.bodyOffset + 28 > sampleEntryBox.endOffset) {
    return null
  }

  const width = buffer.readUInt16BE(sampleEntryBox.bodyOffset + 24)
  const height = buffer.readUInt16BE(sampleEntryBox.bodyOffset + 26)
  if (width <= 0 || width > 32_768 || height <= 0 || height > 32_768) {
    return null
  }

  return { width, height }
}

function parseMp4TkhdDimensions(buffer: Buffer, tkhdBox: Mp4BoxHeader): { width: number; height: number } | null {
  if (tkhdBox.bodyOffset + 4 > tkhdBox.endOffset) {
    return null
  }

  const version = buffer[tkhdBox.bodyOffset]
  const widthOffset = version === 0 ? tkhdBox.bodyOffset + 76 : version === 1 ? tkhdBox.bodyOffset + 88 : null
  const heightOffset = version === 0 ? tkhdBox.bodyOffset + 80 : version === 1 ? tkhdBox.bodyOffset + 92 : null
  if (widthOffset === null || heightOffset === null || heightOffset + 4 > tkhdBox.endOffset) {
    return null
  }

  const width = buffer.readUInt32BE(widthOffset) >>> 16
  const height = buffer.readUInt32BE(heightOffset) >>> 16
  if (width <= 0 || width > 32_768 || height <= 0 || height > 32_768) {
    return null
  }

  return { width, height }
}

function parseMp4StsdVideoMetadata(buffer: Buffer, stsdBox: Mp4BoxHeader): Record<string, number> {
  if (stsdBox.bodyOffset + 8 > stsdBox.endOffset) {
    return {}
  }

  let offset = stsdBox.bodyOffset + 8
  const entryCount = buffer.readUInt32BE(stsdBox.bodyOffset + 4)
  for (let index = 0; index < entryCount && offset + 8 <= stsdBox.endOffset; index += 1) {
    const sampleEntry = readMp4BoxHeader(buffer, offset, stsdBox.endOffset)
    if (!sampleEntry) {
      break
    }

    const metadata = parseMp4VisualSampleEntry(buffer, sampleEntry)
    if (metadata) {
      return {
        video_width_px: metadata.width,
        video_height_px: metadata.height,
      }
    }

    if (sampleEntry.endOffset <= offset) {
      break
    }
    offset = sampleEntry.endOffset
  }

  return {}
}

function readMp4TrackHandlerType(buffer: Buffer, trakBox: Mp4BoxHeader): string | null {
  const mdiaBox = findMp4ChildBox(buffer, trakBox, 'mdia')
  const hdlrBox = mdiaBox ? findMp4ChildBox(buffer, mdiaBox, 'hdlr') : null
  if (!hdlrBox || hdlrBox.bodyOffset + 12 > hdlrBox.endOffset) {
    return null
  }

  return buffer.toString('ascii', hdlrBox.bodyOffset + 8, hdlrBox.bodyOffset + 12)
}

function parseMp4StsdAudioMetadata(buffer: Buffer, stsdBox: Mp4BoxHeader): Record<string, number> {
  if (stsdBox.bodyOffset + 8 > stsdBox.endOffset) {
    return {}
  }

  let offset = stsdBox.bodyOffset + 8
  const entryCount = buffer.readUInt32BE(stsdBox.bodyOffset + 4)
  for (let index = 0; index < entryCount && offset + 8 <= stsdBox.endOffset; index += 1) {
    const sampleEntry = readMp4BoxHeader(buffer, offset, stsdBox.endOffset)
    if (!sampleEntry) {
      break
    }

    const metadata = parseMp4AudioSampleEntry(buffer, sampleEntry)
    if (metadata) {
      return {
        audio_sample_rate_hz: metadata.sampleRate,
        audio_channel_count: metadata.channelCount,
      }
    }

    if (sampleEntry.endOffset <= offset) {
      break
    }
    offset = sampleEntry.endOffset
  }

  return {}
}

function parseMp4TrakAudioMetadata(buffer: Buffer, trakBox: Mp4BoxHeader): Record<string, number> {
  const mdiaBox = findMp4ChildBox(buffer, trakBox, 'mdia')
  const minfBox = mdiaBox ? findMp4ChildBox(buffer, mdiaBox, 'minf') : null
  const stblBox = minfBox ? findMp4ChildBox(buffer, minfBox, 'stbl') : null
  const stsdBox = stblBox ? findMp4ChildBox(buffer, stblBox, 'stsd') : null
  return stsdBox ? parseMp4StsdAudioMetadata(buffer, stsdBox) : {}
}

function parseMp4TrakVideoMetadata(buffer: Buffer, trakBox: Mp4BoxHeader): Record<string, number> {
  const mdiaBox = findMp4ChildBox(buffer, trakBox, 'mdia')
  const minfBox = mdiaBox ? findMp4ChildBox(buffer, mdiaBox, 'minf') : null
  const stblBox = minfBox ? findMp4ChildBox(buffer, minfBox, 'stbl') : null
  const stsdBox = stblBox ? findMp4ChildBox(buffer, stblBox, 'stsd') : null
  const stsdMetadata = stsdBox ? parseMp4StsdVideoMetadata(buffer, stsdBox) : {}
  if (Object.keys(stsdMetadata).length > 0) {
    return stsdMetadata
  }

  const tkhdBox = findMp4ChildBox(buffer, trakBox, 'tkhd')
  const tkhdDimensions = tkhdBox ? parseMp4TkhdDimensions(buffer, tkhdBox) : null
  return tkhdDimensions
    ? {
        video_width_px: tkhdDimensions.width,
        video_height_px: tkhdDimensions.height,
      }
    : {}
}

function parseMp4TrakDurationSeconds(buffer: Buffer, trakBox: Mp4BoxHeader): number | null {
  const mdiaBox = findMp4ChildBox(buffer, trakBox, 'mdia')
  const mdhdBox = mdiaBox ? findMp4ChildBox(buffer, mdiaBox, 'mdhd') : null
  return mdhdBox ? parseMdhdDurationSeconds(buffer, mdhdBox) : null
}

function findMp4TrackBoxByHandlerType(buffer: Buffer, moovBox: Mp4BoxHeader, handlerType: string): Mp4BoxHeader | null {
  let offset = moovBox.bodyOffset
  while (offset + 8 <= moovBox.endOffset) {
    const childBox = readMp4BoxHeader(buffer, offset, moovBox.endOffset)
    if (!childBox) {
      return null
    }

    if (childBox.type === 'trak' && readMp4TrackHandlerType(buffer, childBox) === handlerType) {
      return childBox
    }

    if (childBox.endOffset <= offset) {
      return null
    }
    offset = childBox.endOffset
  }

  return null
}

function parseMp4DataBoxText(buffer: Buffer, dataBox: Mp4BoxHeader): string | null {
  if (dataBox.bodyOffset + 8 > dataBox.endOffset) {
    return null
  }

  return trimTagText(buffer.toString('utf8', dataBox.bodyOffset + 8, dataBox.endOffset))
}

function parseMp4IlstTrackMetadata(buffer: Buffer, ilstBox: Mp4BoxHeader): Record<string, string> {
  let title: string | null = null
  let artist: string | null = null
  let album: string | null = null
  let offset = ilstBox.bodyOffset
  while (offset + 8 <= ilstBox.endOffset) {
    const itemBox = readMp4BoxHeader(buffer, offset, ilstBox.endOffset)
    if (!itemBox) {
      break
    }

    const itemType = buffer.subarray(itemBox.startOffset + 4, itemBox.startOffset + 8)
    const dataBox = findMp4ChildBox(buffer, itemBox, 'data')
    const text = dataBox ? parseMp4DataBoxText(buffer, dataBox) : null
    if (text) {
      if (!title && itemType.equals(MP4_TITLE_METADATA_BOX_TYPE)) {
        title = text
      } else if (!artist && itemType.equals(MP4_ARTIST_METADATA_BOX_TYPE)) {
        artist = text
      } else if (!album && itemType.equals(MP4_ALBUM_METADATA_BOX_TYPE)) {
        album = text
      }
    }

    if (itemBox.endOffset <= offset) {
      break
    }
    offset = itemBox.endOffset
  }

  return {
    ...(title ? { audio_title: title } : {}),
    ...(artist ? { audio_artist: artist } : {}),
    ...(album ? { audio_album: album } : {}),
  }
}

function extractMp4AudioMetadata(filePath: string, fileBytes: number | undefined): Record<string, string | number> {
  const moovData = readMp4MoovBuffer(filePath, fileBytes)
  if (!moovData) {
    return {}
  }

  const audioTrackBox = findMp4TrackBoxByHandlerType(moovData.buffer, moovData.moovBox, 'soun')
  const audioStreamMetadata = audioTrackBox ? parseMp4TrakAudioMetadata(moovData.buffer, audioTrackBox) : {}
  const udtaBox = findMp4ChildBox(moovData.buffer, moovData.moovBox, 'udta')
  const metaBox = udtaBox ? findMp4ChildBox(moovData.buffer, udtaBox, 'meta') : null
  const ilstBox = metaBox
    ? findMp4ChildBox(moovData.buffer, metaBox, 'ilst', metaBox.bodyOffset + 4)
    : null
  const trackMetadata = ilstBox ? parseMp4IlstTrackMetadata(moovData.buffer, ilstBox) : {}
  return { ...audioStreamMetadata, ...trackMetadata }
}

function extractMp4VideoMetadata(filePath: string, fileBytes: number | undefined): Record<string, number> {
  const moovData = readMp4MoovBuffer(filePath, fileBytes)
  if (!moovData) {
    return {}
  }

  const videoTrackBox = findMp4TrackBoxByHandlerType(moovData.buffer, moovData.moovBox, 'vide')
  const audioTrackBox = findMp4TrackBoxByHandlerType(moovData.buffer, moovData.moovBox, 'soun')
  return {
    ...(videoTrackBox ? parseMp4TrakVideoMetadata(moovData.buffer, videoTrackBox) : {}),
    ...(audioTrackBox ? parseMp4TrakAudioMetadata(moovData.buffer, audioTrackBox) : {}),
  }
}

function extractMp4DurationMetadata(
  filePath: string,
  fileBytes: number | undefined,
  fileType: NonCodeFileType,
): Record<string, number> {
  const moovData = readMp4MoovBuffer(filePath, fileBytes)
  if (!moovData) {
    return {}
  }

  const durationFromMoov = moovData ? parseMoovDurationSeconds(moovData.buffer, moovData.moovBox) : null
  if (durationFromMoov !== null) {
    return { media_duration_seconds: durationFromMoov }
  }

  const preferredTrackTypes = fileType === 'video' ? ['vide', 'soun'] : ['soun']
  const durationSeconds = preferredTrackTypes
    .map((handlerType) => findMp4TrackBoxByHandlerType(moovData.buffer, moovData.moovBox, handlerType))
    .map((trakBox) => (trakBox ? parseMp4TrakDurationSeconds(moovData.buffer, trakBox) : null))
    .find((duration): duration is number => duration !== null)
  return durationSeconds !== undefined ? { media_duration_seconds: durationSeconds } : {}
}

function extractBinaryDurationMetadata(
  filePath: string,
  extension: string,
  fileType: NonCodeFileType,
  fileBytes: number | undefined,
): Record<string, number> {
  if (fileType === 'audio' && extension === '.wav') {
    return extractWavDurationMetadata(filePath, fileBytes)
  }

  if ((fileType === 'audio' || fileType === 'video') && MP4_FAMILY_EXTENSIONS.has(extension)) {
    return extractMp4DurationMetadata(filePath, fileBytes, fileType)
  }

  return {}
}

function parseSynchsafeInteger(buffer: Buffer, offset: number): number | null {
  if (offset + 4 > buffer.length) {
    return null
  }

  const byte0 = buffer[offset] ?? 0
  const byte1 = buffer[offset + 1] ?? 0
  const byte2 = buffer[offset + 2] ?? 0
  const byte3 = buffer[offset + 3] ?? 0
  if ((byte0 & 0x80) !== 0 || (byte1 & 0x80) !== 0 || (byte2 & 0x80) !== 0 || (byte3 & 0x80) !== 0) {
    return null
  }

  return (
    (byte0 << 21) |
    (byte1 << 14) |
    (byte2 << 7) |
    byte3
  )
}

function trimTagText(value: string): string | null {
  const trimmed = value.replace(/\u0000+/g, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseVorbisCommentBody(buffer: Buffer): Record<string, string> {
  if (buffer.length < 8) {
    return {}
  }

  let offset = 0
  const vendorLength = buffer.readUInt32LE(offset)
  offset += 4
  if (offset + vendorLength > buffer.length) {
    return {}
  }
  offset += vendorLength

  if (offset + 4 > buffer.length) {
    return {}
  }

  const commentCount = buffer.readUInt32LE(offset)
  offset += 4

  let title: string | null = null
  let artist: string | null = null
  let album: string | null = null
  for (let index = 0; index < commentCount; index += 1) {
    if (offset + 4 > buffer.length) {
      return {}
    }

    const commentLength = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + commentLength > buffer.length) {
      return {}
    }

    const entry = buffer.toString('utf8', offset, offset + commentLength)
    offset += commentLength

    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = entry.slice(0, separatorIndex).trim().toUpperCase()
    const value = trimTagText(entry.slice(separatorIndex + 1))
    if (!value) {
      continue
    }

    if (key === 'TITLE' && !title) {
      title = value
    } else if (key === 'ARTIST' && !artist) {
      artist = value
    } else if (key === 'ALBUM' && !album) {
      album = value
    }
  }

  return {
    ...(title ? { audio_title: title } : {}),
    ...(artist ? { audio_artist: artist } : {}),
    ...(album ? { audio_album: album } : {}),
  }
}

function decodeUtf16Buffer(buffer: Buffer, littleEndian: boolean): string | null {
  if (buffer.length === 0) {
    return ''
  }

  if (buffer.length % 2 !== 0) {
    return null
  }

  const content = Buffer.from(buffer)
  if (!littleEndian) {
    content.swap16()
  }
  return content.toString('utf16le')
}

function decodeId3TextFrame(payload: Buffer): string | null {
  if (payload.length === 0) {
    return null
  }

  const encoding = payload[0]
  const content = payload.subarray(1)
  if (content.length === 0) {
    return null
  }

  switch (encoding) {
    case 0:
      return trimTagText(content.toString('latin1'))
    case 1: {
      if (content.length >= 2) {
        if (content[0] === 0xff && content[1] === 0xfe) {
          const decoded = decodeUtf16Buffer(content.subarray(2), true)
          return decoded === null ? null : trimTagText(decoded)
        }
        if (content[0] === 0xfe && content[1] === 0xff) {
          const decoded = decodeUtf16Buffer(content.subarray(2), false)
          return decoded === null ? null : trimTagText(decoded)
        }
      }
      const decoded = decodeUtf16Buffer(content, true)
      return decoded === null ? null : trimTagText(decoded)
    }
    case 2: {
      const decoded = decodeUtf16Buffer(content, false)
      return decoded === null ? null : trimTagText(decoded)
    }
    case 3:
      return trimTagText(content.toString('utf8'))
    default:
      return null
  }
}

function extractMp3Id3v1TrackMetadata(filePath: string, fileBytes: number): Record<string, string> {
  if (fileBytes < 128) {
    return {}
  }

  const trailer = readFileWindow(filePath, fileBytes - 128, 128)
  if (!trailer || trailer.length < 128 || trailer.toString('ascii', 0, 3) !== 'TAG') {
    return {}
  }

  const title = trimTagText(trailer.toString('latin1', 3, 33))
  const artist = trimTagText(trailer.toString('latin1', 33, 63))
  const album = trimTagText(trailer.toString('latin1', 63, 93))

  return {
    ...(title ? { audio_title: title } : {}),
    ...(artist ? { audio_artist: artist } : {}),
    ...(album ? { audio_album: album } : {}),
  }
}

function extractMp3Id3TrackMetadata(filePath: string, fileBytes: number | undefined): Record<string, string> {
  if (!fileBytes || fileBytes < 10) {
    return {}
  }

  const head = readFileWindow(filePath, 0, Math.min(fileBytes, MP3_ID3_SCAN_BYTES))
  if (!head || head.length < 10) {
    return {}
  }

  if (head.toString('ascii', 0, 3) !== 'ID3') {
    return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
  }

  const version = head[3]
  if (version !== 3 && version !== 4) {
    return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
  }

  const tagSize = parseSynchsafeInteger(head, 6)
  if (tagSize === null) {
    return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
  }

  const totalTagBytes = 10 + tagSize
  if (totalTagBytes > fileBytes) {
    return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
  }

  const parseLimit = Math.min(totalTagBytes, head.length)

  let offset = 10
  const tagFlags = head[5] ?? 0
  if ((tagFlags & 0x40) !== 0) {
    const extendedHeaderSize =
      version === 4
        ? parseSynchsafeInteger(head, offset)
        : offset + 4 <= parseLimit
          ? head.readUInt32BE(offset)
          : null
    if (extendedHeaderSize === null) {
      return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
    }

    const extendedHeaderBytes = version === 4 ? extendedHeaderSize : 4 + extendedHeaderSize
    const minimumExtendedHeaderBytes = version === 4 ? 6 : 10
    if (extendedHeaderBytes < minimumExtendedHeaderBytes || offset + extendedHeaderBytes > parseLimit) {
      return extractMp3Id3v1TrackMetadata(filePath, fileBytes)
    }
    offset += extendedHeaderBytes
  }

  let title: string | null = null
  let artist: string | null = null
  let album: string | null = null
  while (offset + 10 <= parseLimit) {
    const frameId = head.toString('ascii', offset, offset + 4)
    if (/^\u0000{4}$/.test(frameId)) {
      break
    }

    const frameSize = version === 4 ? parseSynchsafeInteger(head, offset + 4) : head.readUInt32BE(offset + 4)
    if (frameSize === null || frameSize <= 0 || offset + 10 + frameSize > parseLimit) {
      break
    }

    const payload = head.subarray(offset + 10, offset + 10 + frameSize)
    if (frameId === 'TIT2') {
      title = decodeId3TextFrame(payload)
    } else if (frameId === 'TPE1') {
      artist = decodeId3TextFrame(payload)
    } else if (frameId === 'TALB') {
      album = decodeId3TextFrame(payload)
    }

    offset += 10 + frameSize
  }

  const metadata = {
    ...(title ? { audio_title: title } : {}),
    ...(artist ? { audio_artist: artist } : {}),
    ...(album ? { audio_album: album } : {}),
  }

  return Object.keys(metadata).length > 0 ? metadata : extractMp3Id3v1TrackMetadata(filePath, fileBytes)
}

interface OggPageHeader {
  bitstreamSerialNumber: number
  headerType: number
  granulePosition: bigint
  segmentTableOffset: number
  pageSegments: number
  payloadOffset: number
  pageEnd: number
}

interface AacAdtsHeader {
  sampleRate: number
  channelCount: number
  frameLength: number
  sampleCount: number
}

interface EbmlElementHeader {
  id: number
  startOffset: number
  bodyOffset: number
  endOffset: number
  actualEndOffset: number
}

function extractFlacAudioMetadata(filePath: string, fileBytes: number | undefined): Record<string, string | number> {
  if (!fileBytes || fileBytes < 8) {
    return {}
  }

  const signature = readFileWindow(filePath, 0, 4)
  if (!signature || signature.length < 4 || signature.toString('ascii', 0, 4) !== 'fLaC') {
    return {}
  }

  let offset = 4
  let sampleRate: number | null = null
  let channelCount: number | null = null
  let durationSeconds: number | null = null
  let trackMetadata: Record<string, string> = {}
  while (offset + 4 <= fileBytes) {
    const blockHeader = readFileWindow(filePath, offset, 4)
    if (!blockHeader || blockHeader.length < 4) {
      break
    }

    const blockTypeWithFlags = blockHeader[0] ?? 0
    const isLast = (blockTypeWithFlags & 0x80) !== 0
    const blockType = blockTypeWithFlags & 0x7f
    const blockLength = blockHeader.readUIntBE(1, 3)
    const payloadOffset = offset + 4
    const payloadEnd = payloadOffset + blockLength
    if (payloadEnd > fileBytes) {
      break
    }

    if (blockType === 0 && blockLength >= 34) {
      const streamInfo = readFileWindow(filePath, payloadOffset, 34)
      if (streamInfo && streamInfo.length >= 34) {
        const packedHeader = streamInfo.readBigUInt64BE(10)
        const parsedSampleRate = Number((packedHeader >> 44n) & 0x0f_ffffn)
        const parsedChannelCount = Number(((packedHeader >> 41n) & 0x07n) + 1n)
        const totalSamples = Number(packedHeader & 0x0f_ffff_ffffn)
        sampleRate = parsedSampleRate > 0 ? parsedSampleRate : null
        channelCount = parsedChannelCount > 0 ? parsedChannelCount : null
        durationSeconds = sampleRate && totalSamples > 0 ? roundDurationSeconds(totalSamples / sampleRate) : null
      }
    } else if (blockType === 4) {
      if (blockLength <= FLAC_METADATA_SCAN_BYTES) {
        const vorbisComment = readFileWindow(filePath, payloadOffset, blockLength)
        if (vorbisComment && vorbisComment.length >= blockLength) {
          trackMetadata = parseVorbisCommentBody(vorbisComment)
        }
      }
    }

    offset = payloadEnd
    if (isLast) {
      break
    }
  }

  return {
    ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
    ...(sampleRate ? { audio_sample_rate_hz: sampleRate } : {}),
    ...(channelCount ? { audio_channel_count: channelCount } : {}),
    ...trackMetadata,
  }
}

function readOggPageHeader(buffer: Buffer, offset: number, limit: number): OggPageHeader | null {
  if (offset + 27 > limit || buffer.toString('ascii', offset, offset + 4) !== 'OggS' || buffer[offset + 4] !== 0) {
    return null
  }

  const pageSegments = buffer[offset + 26] ?? 0
  const segmentTableOffset = offset + 27
  const payloadOffset = segmentTableOffset + pageSegments
  if (payloadOffset > limit) {
    return null
  }

  let payloadLength = 0
  for (let index = 0; index < pageSegments; index += 1) {
    payloadLength += buffer[segmentTableOffset + index] ?? 0
  }

  const pageEnd = payloadOffset + payloadLength
  if (pageEnd > limit) {
    return null
  }

  return {
    bitstreamSerialNumber: buffer.readUInt32LE(offset + 14),
    headerType: buffer[offset + 5] ?? 0,
    granulePosition: buffer.readBigUInt64LE(offset + 6),
    segmentTableOffset,
    pageSegments,
    payloadOffset,
    pageEnd,
  }
}

function readOggHeadPackets(buffer: Buffer, maxPackets: number, bitstreamSerialNumber: number): Buffer[] {
  const packets: Buffer[] = []
  let offset = 0
  let currentPacketChunks: Buffer[] = []
  while (offset + 27 <= buffer.length && packets.length < maxPackets) {
    const page = readOggPageHeader(buffer, offset, buffer.length)
    if (!page) {
      break
    }
    if (page.bitstreamSerialNumber !== bitstreamSerialNumber) {
      if (page.pageEnd <= offset) {
        break
      }
      offset = page.pageEnd
      continue
    }
    if ((page.headerType & 0x01) !== 0 && currentPacketChunks.length === 0) {
      break
    }

    let payloadCursor = page.payloadOffset
    for (let index = 0; index < page.pageSegments && packets.length < maxPackets; index += 1) {
      const segmentLength = buffer[page.segmentTableOffset + index] ?? 0
      const segmentEnd = payloadCursor + segmentLength
      if (segmentEnd > page.pageEnd) {
        return packets
      }

      currentPacketChunks.push(buffer.subarray(payloadCursor, segmentEnd))
      payloadCursor = segmentEnd
      if (segmentLength < 255) {
        packets.push(Buffer.concat(currentPacketChunks))
        currentPacketChunks = []
      }
    }

    if (page.pageEnd <= offset) {
      break
    }
    offset = page.pageEnd
  }

  return packets
}

function findSupportedOggAudioHead(buffer: Buffer): { bitstreamSerialNumber: number; packets: Buffer[] } | null {
  const visitedSerialNumbers = new Set<number>()
  let offset = 0
  while (offset + 27 <= buffer.length) {
    const page = readOggPageHeader(buffer, offset, buffer.length)
    if (!page) {
      break
    }

    if ((page.headerType & 0x02) !== 0 && !visitedSerialNumbers.has(page.bitstreamSerialNumber)) {
      visitedSerialNumbers.add(page.bitstreamSerialNumber)
      const packets = readOggHeadPackets(buffer, 2, page.bitstreamSerialNumber)
      const firstPacket = packets[0]
      if (firstPacket && (parseVorbisIdentificationPacket(firstPacket) || parseOpusHeadPacket(firstPacket))) {
        return { bitstreamSerialNumber: page.bitstreamSerialNumber, packets }
      }
    }

    if (page.pageEnd <= offset) {
      break
    }
    offset = page.pageEnd
  }

  return null
}

function parseVorbisIdentificationPacket(packet: Buffer): { sampleRate: number; channelCount: number } | null {
  if (packet.length < 30 || packet[0] !== 1 || packet.toString('ascii', 1, 7) !== 'vorbis') {
    return null
  }

  const channelCount = packet[11] ?? 0
  const sampleRate = packet.readUInt32LE(12)
  if (channelCount <= 0 || sampleRate <= 0) {
    return null
  }

  return { sampleRate, channelCount }
}

function parseOpusHeadPacket(packet: Buffer): { sampleRate: number; channelCount: number; preSkip: number } | null {
  if (packet.length < 19 || packet.toString('ascii', 0, 8) !== 'OpusHead') {
    return null
  }

  const channelCount = packet[9] ?? 0
  const preSkip = packet.readUInt16LE(10)
  if (channelCount <= 0) {
    return null
  }

  return {
    sampleRate: 48_000,
    channelCount,
    preSkip,
  }
}

function parseVorbisCommentPacket(packet: Buffer): Record<string, string> {
  if (packet.length < 8 || packet[0] !== 3 || packet.toString('ascii', 1, 7) !== 'vorbis' || packet[packet.length - 1] !== 1) {
    return {}
  }

  return parseVorbisCommentBody(packet.subarray(7, packet.length - 1))
}

function parseOpusTagsPacket(packet: Buffer): Record<string, string> {
  if (packet.length < 8 || packet.toString('ascii', 0, 8) !== 'OpusTags') {
    return {}
  }

  return parseVorbisCommentBody(packet.subarray(8))
}

function findLastOggPageGranulePosition(filePath: string, fileBytes: number, bitstreamSerialNumber: number): bigint | null {
  let windowEnd = fileBytes
  while (windowEnd > 0) {
    const windowStart = Math.max(0, windowEnd - OGG_TAIL_SCAN_BYTES)
    const windowSize = windowEnd - windowStart
    const buffer = readFileWindow(filePath, windowStart, windowSize)
    if (!buffer || buffer.length < 27) {
      return null
    }

    for (let offset = buffer.length - 27; offset >= 0; offset -= 1) {
      if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
        continue
      }

      const page = readOggPageHeader(buffer, offset, buffer.length)
      if (!page || page.bitstreamSerialNumber !== bitstreamSerialNumber || page.granulePosition === 0xffff_ffff_ffff_ffffn) {
        continue
      }

      return page.granulePosition
    }

    if (windowStart === 0) {
      break
    }

    windowEnd = Math.min(fileBytes, windowStart + OGG_PAGE_SCAN_OVERLAP_BYTES)
  }

  return null
}

function parseAacAdtsHeader(buffer: Buffer): AacAdtsHeader | null {
  if (
    buffer.length < 7 ||
    buffer[0] !== 0xff ||
    ((buffer[1] ?? 0) & 0xf0) !== 0xf0 ||
    ((buffer[1] ?? 0) & 0x06) !== 0
  ) {
    return null
  }

  const sampleRateIndex = ((buffer[2] ?? 0) >> 2) & 0x0f
  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex] ?? null
  const channelCount = (((buffer[2] ?? 0) & 0x01) << 2) | (((buffer[3] ?? 0) >> 6) & 0x03)
  const headerLength = ((buffer[1] ?? 0) & 0x01) === 0 ? 9 : 7
  const frameLength = (((buffer[3] ?? 0) & 0x03) << 11) | ((buffer[4] ?? 0) << 3) | (((buffer[5] ?? 0) >> 5) & 0x07)
  const rawBlocks = ((buffer[6] ?? 0) & 0x03) + 1
  if (!sampleRate || channelCount <= 0 || channelCount > 16 || frameLength < headerLength) {
    return null
  }

  return {
    sampleRate,
    channelCount,
    frameLength,
    sampleCount: AAC_SAMPLES_PER_RAW_BLOCK * rawBlocks,
  }
}

function readEbmlVariableLength(buffer: Buffer, offset: number, limit: number): { length: number; markerMask: number } | null {
  if (offset >= limit) {
    return null
  }

  const firstByte = buffer[offset]
  if (!firstByte) {
    return null
  }

  for (let length = 1; length <= 8; length += 1) {
    const markerMask = 1 << (8 - length)
    if ((firstByte & markerMask) !== 0) {
      return offset + length <= limit ? { length, markerMask } : null
    }
  }

  return null
}

function parseEbmlElementId(buffer: Buffer, offset: number, limit: number): { id: number; length: number } | null {
  const vint = readEbmlVariableLength(buffer, offset, limit)
  if (!vint) {
    return null
  }

  let id = 0
  for (let index = 0; index < vint.length; index += 1) {
    id = (id << 8) | (buffer[offset + index] ?? 0)
  }

  return { id, length: vint.length }
}

function parseEbmlElementSize(buffer: Buffer, offset: number, limit: number): { size: number | null; length: number } | null {
  const vint = readEbmlVariableLength(buffer, offset, limit)
  if (!vint) {
    return null
  }

  let size = BigInt((buffer[offset] ?? 0) & (vint.markerMask - 1))
  let isUnknownSize = size === BigInt(vint.markerMask - 1)
  for (let index = 1; index < vint.length; index += 1) {
    const byte = buffer[offset + index] ?? 0
    size = (size << 8n) | BigInt(byte)
    isUnknownSize = isUnknownSize && byte === 0xff
  }

  if (isUnknownSize) {
    return { size: null, length: vint.length }
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }

  return { size: Number(size), length: vint.length }
}

function readEbmlElementHeader(buffer: Buffer, offset: number, limit: number): EbmlElementHeader | null {
  const id = parseEbmlElementId(buffer, offset, limit)
  if (!id) {
    return null
  }

  const size = parseEbmlElementSize(buffer, offset + id.length, limit)
  if (!size) {
    return null
  }

  const bodyOffset = offset + id.length + size.length
  if (bodyOffset > limit) {
    return null
  }

  return {
    id: id.id,
    startOffset: offset,
    bodyOffset,
    endOffset: size.size === null ? limit : Math.min(limit, bodyOffset + size.size),
    actualEndOffset: size.size === null ? limit : bodyOffset + size.size,
  }
}

function findEbmlChildElement(
  buffer: Buffer,
  parentElement: EbmlElementHeader,
  elementId: number,
  startOffset: number = parentElement.bodyOffset,
): EbmlElementHeader | null {
  let offset = startOffset
  while (offset < parentElement.endOffset) {
    const childElement = readEbmlElementHeader(buffer, offset, parentElement.endOffset)
    if (!childElement) {
      return null
    }
    if (childElement.id === elementId) {
      return childElement
    }
    if (childElement.endOffset <= offset) {
      return null
    }
    offset = childElement.endOffset
  }

  return null
}

function readEbmlUnsignedValue(buffer: Buffer, element: EbmlElementHeader): number | null {
  const byteLength = element.endOffset - element.bodyOffset
  if (byteLength <= 0 || byteLength > 8) {
    return null
  }

  let value = 0n
  for (let index = element.bodyOffset; index < element.endOffset; index += 1) {
    value = (value << 8n) | BigInt(buffer[index] ?? 0)
  }

  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

function readEbmlFloatValue(buffer: Buffer, element: EbmlElementHeader): number | null {
  const byteLength = element.endOffset - element.bodyOffset
  if (byteLength === 4) {
    return buffer.readFloatBE(element.bodyOffset)
  }
  if (byteLength === 8) {
    return buffer.readDoubleBE(element.bodyOffset)
  }

  return null
}

function parseMatroskaSeekHeadTargets(
  buffer: Buffer,
  segment: EbmlElementHeader,
): { infoPositions: number[], tracksPositions: number[] } {
  const infoPositions: number[] = []
  const tracksPositions: number[] = []
  let offset = segment.bodyOffset
  while (offset < segment.endOffset) {
    const childElement = readEbmlElementHeader(buffer, offset, segment.endOffset)
    if (!childElement) {
      break
    }

    if (childElement.id === MATROSKA_SEEK_HEAD_ID) {
      let seekOffset = childElement.bodyOffset
      while (seekOffset < childElement.endOffset) {
        const seekEntry = readEbmlElementHeader(buffer, seekOffset, childElement.endOffset)
        if (!seekEntry) {
          break
        }

        if (seekEntry.id === MATROSKA_SEEK_ENTRY_ID) {
          const seekIdElement = findEbmlChildElement(buffer, seekEntry, MATROSKA_SEEK_ID_ID)
          const seekPositionElement = findEbmlChildElement(buffer, seekEntry, MATROSKA_SEEK_POSITION_ID)
          const targetId = seekIdElement ? readEbmlUnsignedValue(buffer, seekIdElement) : null
          const targetPosition = seekPositionElement ? readEbmlUnsignedValue(buffer, seekPositionElement) : null
          if (targetPosition !== null && targetPosition >= 0) {
            if (targetId === MATROSKA_INFO_ID && infoPositions.length < MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && !infoPositions.includes(targetPosition)) {
              infoPositions.push(targetPosition)
            } else if (targetId === MATROSKA_TRACKS_ID && tracksPositions.length < MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && !tracksPositions.includes(targetPosition)) {
              tracksPositions.push(targetPosition)
            }
          }
        }

        if (seekEntry.endOffset <= seekOffset) {
          break
        }
        seekOffset = seekEntry.endOffset
      }
    }

    if (infoPositions.length >= MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && tracksPositions.length >= MATROSKA_MAX_SEEK_TARGETS_PER_TYPE) {
      break
    }

    if (childElement.endOffset <= offset) {
      break
    }
    offset = childElement.endOffset
  }

  return { infoPositions, tracksPositions }
}

function parseMatroskaTopLevelTargets(
  filePath: string,
  fileBytes: number,
  segment: EbmlElementHeader,
): { infoPositions: number[], tracksPositions: number[] } {
  if (segment.bodyOffset < 0 || segment.bodyOffset >= fileBytes) {
    return { infoPositions: [], tracksPositions: [] }
  }

  const segmentWindow = readFileWindow(
    filePath,
    segment.bodyOffset,
    Math.min(fileBytes - segment.bodyOffset, MATROSKA_TOP_LEVEL_SCAN_BYTES),
  )
  if (!segmentWindow) {
    return { infoPositions: [], tracksPositions: [] }
  }

  const infoPositions: number[] = []
  const tracksPositions: number[] = []
  let offset = 0
  while (offset < segmentWindow.length) {
    const childElement = readEbmlElementHeader(segmentWindow, offset, segmentWindow.length)
    if (!childElement) {
      break
    }

    if (childElement.id === MATROSKA_INFO_ID && infoPositions.length < MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && !infoPositions.includes(childElement.startOffset)) {
      infoPositions.push(childElement.startOffset)
    } else if (childElement.id === MATROSKA_TRACKS_ID && tracksPositions.length < MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && !tracksPositions.includes(childElement.startOffset)) {
      tracksPositions.push(childElement.startOffset)
    }

    if (infoPositions.length >= MATROSKA_MAX_SEEK_TARGETS_PER_TYPE && tracksPositions.length >= MATROSKA_MAX_SEEK_TARGETS_PER_TYPE) {
      break
    }

    if (childElement.endOffset <= offset) {
      break
    }
    offset = childElement.endOffset
  }

  return { infoPositions, tracksPositions }
}

function parseMatroskaAudioTrackMetadata(
  buffer: Buffer,
  trackEntry: EbmlElementHeader,
): { sampleRate: number | null, channelCount: number | null } {
  const audioElement = findEbmlChildElement(buffer, trackEntry, MATROSKA_AUDIO_ID)
  if (!audioElement) {
    return { sampleRate: null, channelCount: null }
  }

  const samplingFrequencyElement = findEbmlChildElement(buffer, audioElement, MATROSKA_SAMPLING_FREQUENCY_ID)
  const channelsElement = findEbmlChildElement(buffer, audioElement, MATROSKA_CHANNELS_ID)
  const rawSampleRate = samplingFrequencyElement ? readEbmlFloatValue(buffer, samplingFrequencyElement) : null
  const rawChannelCount = channelsElement ? readEbmlUnsignedValue(buffer, channelsElement) : null

  return {
    sampleRate:
      rawSampleRate !== null && Number.isFinite(rawSampleRate) && rawSampleRate >= 1_000 && rawSampleRate <= 384_000
        ? Math.round(rawSampleRate)
        : null,
    channelCount: rawChannelCount && rawChannelCount > 0 && rawChannelCount <= 16 ? rawChannelCount : null,
  }
}

function parseMatroskaInfoMetadata(buffer: Buffer, infoElement: EbmlElementHeader): number | null {
  const timecodeScaleElement = findEbmlChildElement(buffer, infoElement, MATROSKA_TIMECODE_SCALE_ID)
  const durationElement = findEbmlChildElement(buffer, infoElement, MATROSKA_DURATION_ID)
  const timecodeScale = timecodeScaleElement ? readEbmlUnsignedValue(buffer, timecodeScaleElement) : MATROSKA_DEFAULT_TIMECODE_SCALE_NS
  const rawDuration = durationElement ? readEbmlFloatValue(buffer, durationElement) : null
  return timecodeScale !== null && timecodeScale > 0 && rawDuration !== null && Number.isFinite(rawDuration) && rawDuration >= 0
    ? roundDurationSeconds((rawDuration * timecodeScale) / 1_000_000_000)
    : null
}

function hasMatroskaAuthoritativeInfoWithoutDuration(buffer: Buffer, infoElement: EbmlElementHeader): boolean {
  let offset = infoElement.bodyOffset
  while (offset < infoElement.endOffset) {
    const childElement = readEbmlElementHeader(buffer, offset, infoElement.endOffset)
    if (!childElement || childElement.endOffset <= offset) {
      return false
    }
    if (childElement.id === MATROSKA_DURATION_ID) {
      return false
    }
    if (childElement.actualEndOffset > infoElement.actualEndOffset) {
      return false
    }
    if (childElement.actualEndOffset === infoElement.actualEndOffset) {
      return true
    }
    offset = childElement.endOffset
  }
  return false
}

function hasMatroskaUnreadableInfoChildAfter(buffer: Buffer, infoElement: EbmlElementHeader, startOffset: number): boolean {
  let offset = startOffset
  while (offset < infoElement.endOffset) {
    const childElement = readEbmlElementHeader(buffer, offset, infoElement.endOffset)
    if (!childElement || childElement.endOffset <= offset) {
      return true
    }
    if (childElement.actualEndOffset > infoElement.actualEndOffset) {
      return true
    }
    offset = childElement.endOffset
  }
  return false
}

function parseMatroskaBoundedInfoMetadata(buffer: Buffer, infoElement: EbmlElementHeader): number | null | undefined {
  const parsedDuration = parseMatroskaInfoMetadata(buffer, infoElement)
  if (parsedDuration !== null) {
    return parsedDuration
  }
  const durationElement = findEbmlChildElement(buffer, infoElement, MATROSKA_DURATION_ID)
  if (durationElement && isEbmlElementFullyBuffered(buffer, durationElement)) {
    const timecodeScaleElement = findEbmlChildElement(buffer, infoElement, MATROSKA_TIMECODE_SCALE_ID)
    if (
      (!timecodeScaleElement || isEbmlElementFullyBuffered(buffer, timecodeScaleElement))
      && !hasMatroskaUnreadableInfoChildAfter(buffer, infoElement, durationElement.endOffset)
    ) {
      return null
    }
  }
  if (!durationElement && hasMatroskaAuthoritativeInfoWithoutDuration(buffer, infoElement)) {
    return null
  }
  return undefined
}

function parseMatroskaTracksMetadata(
  buffer: Buffer,
  tracksElement: EbmlElementHeader,
): { width: number | null, height: number | null, audioSampleRate: number | null, audioChannelCount: number | null } {
  let width: number | null = null
  let height: number | null = null
  let audioSampleRate: number | null = null
  let audioChannelCount: number | null = null
  let offset = tracksElement.bodyOffset
  while (offset < tracksElement.endOffset) {
    const trackEntry = readEbmlElementHeader(buffer, offset, tracksElement.endOffset)
    if (!trackEntry) {
      break
    }

    if (trackEntry.id === MATROSKA_TRACK_ENTRY_ID) {
      const trackTypeElement = findEbmlChildElement(buffer, trackEntry, MATROSKA_TRACK_TYPE_ID)
      const trackType = trackTypeElement ? readEbmlUnsignedValue(buffer, trackTypeElement) : null
      if (trackType === 1) {
        const videoElement = findEbmlChildElement(buffer, trackEntry, MATROSKA_VIDEO_ID)
        const widthElement = videoElement ? findEbmlChildElement(buffer, videoElement, MATROSKA_PIXEL_WIDTH_ID) : null
        const heightElement = videoElement ? findEbmlChildElement(buffer, videoElement, MATROSKA_PIXEL_HEIGHT_ID) : null
        const parsedWidth = widthElement ? readEbmlUnsignedValue(buffer, widthElement) : null
        const parsedHeight = heightElement ? readEbmlUnsignedValue(buffer, heightElement) : null
        width = width ?? (parsedWidth && parsedWidth > 0 && parsedWidth <= 32_768 ? parsedWidth : null)
        height = height ?? (parsedHeight && parsedHeight > 0 && parsedHeight <= 32_768 ? parsedHeight : null)
      } else if (trackType === 2) {
        const audioMetadata = parseMatroskaAudioTrackMetadata(buffer, trackEntry)
        audioSampleRate = audioSampleRate ?? audioMetadata.sampleRate
        audioChannelCount = audioChannelCount ?? audioMetadata.channelCount
      }

      if (width !== null && height !== null && audioSampleRate !== null && audioChannelCount !== null) {
        break
      }
    }

    if (trackEntry.endOffset <= offset) {
      break
    }
    offset = trackEntry.endOffset
  }

  return { width, height, audioSampleRate, audioChannelCount }
}

function hasMatroskaTrackMetadata(metadata: {
  width: number | null
  height: number | null
  audioSampleRate: number | null
  audioChannelCount: number | null
}): boolean {
  return metadata.width !== null
    || metadata.height !== null
    || metadata.audioSampleRate !== null
    || metadata.audioChannelCount !== null
}

function hasMatroskaUnreadableTracksChild(buffer: Buffer, tracksElement: EbmlElementHeader): boolean {
  let offset = tracksElement.bodyOffset
  while (offset < tracksElement.endOffset) {
    const childElement = readEbmlElementHeader(buffer, offset, tracksElement.endOffset)
    if (!childElement || childElement.endOffset <= offset) {
      return true
    }
    if (childElement.actualEndOffset > tracksElement.actualEndOffset) {
      return true
    }
    offset = childElement.endOffset
  }
  return false
}

function parseMatroskaBoundedTracksMetadata(
  buffer: Buffer,
  tracksElement: EbmlElementHeader,
): { width: number | null, height: number | null, audioSampleRate: number | null, audioChannelCount: number | null } | undefined {
  const metadata = parseMatroskaTracksMetadata(buffer, tracksElement)
  if (hasMatroskaUnreadableTracksChild(buffer, tracksElement)) {
    return undefined
  }
  if (hasMatroskaTrackMetadata(metadata) || isEbmlElementFullyBuffered(buffer, tracksElement)) {
    return metadata
  }
  return undefined
}

function readMatroskaSeekTargetElement(
  filePath: string,
  fileBytes: number,
  segment: EbmlElementHeader,
  seekPosition: number,
  expectedId: number,
): { buffer: Buffer, element: EbmlElementHeader } | null {
  const absoluteOffset = segment.bodyOffset + seekPosition
  if (seekPosition < 0 || absoluteOffset < 0 || absoluteOffset >= fileBytes) {
    return null
  }

  const window = readFileWindow(filePath, absoluteOffset, Math.min(fileBytes - absoluteOffset, MATROSKA_SEEK_TARGET_SCAN_BYTES))
  if (!window) {
    return null
  }

  const element = readEbmlElementHeader(window, 0, window.length)
  if (!element || element.id !== expectedId) {
    return null
  }

  return { buffer: window, element }
}

function isEbmlElementFullyBuffered(buffer: Buffer, element: EbmlElementHeader): boolean {
  return element.actualEndOffset <= buffer.length
}

function findMatroskaSegmentElement(buffer: Buffer): EbmlElementHeader | null {
  const ebmlHeader = readEbmlElementHeader(buffer, 0, buffer.length)
  if (!ebmlHeader || ebmlHeader.id !== MATROSKA_EBML_HEADER_ID) {
    return null
  }

  let offset = ebmlHeader.endOffset
  while (offset < buffer.length) {
    const element = readEbmlElementHeader(buffer, offset, buffer.length)
    if (!element) {
      return null
    }
    if (element.id === MATROSKA_SEGMENT_ID) {
      return element
    }
    if (element.endOffset <= offset) {
      return null
    }
    offset = element.endOffset
  }

  return null
}

function extractMatroskaVideoMetadata(filePath: string, fileBytes: number | undefined): Record<string, number> {
  if (!fileBytes || fileBytes < 12) {
    return {}
  }

  const head = readFileWindow(filePath, 0, Math.min(fileBytes, MATROSKA_METADATA_SCAN_BYTES))
  if (!head || head.length < 12) {
    return {}
  }

  const segment = findMatroskaSegmentElement(head)
  if (!segment) {
    return {}
  }

  const infoElement = findEbmlChildElement(head, segment, MATROSKA_INFO_ID)
  const tracksElement = findEbmlChildElement(head, segment, MATROSKA_TRACKS_ID)
  const seekHeadTargets = parseMatroskaSeekHeadTargets(head, segment)
  const topLevelTargets = parseMatroskaTopLevelTargets(filePath, fileBytes, segment)
  const directDurationSeconds = infoElement
    ? parseMatroskaBoundedInfoMetadata(head, infoElement)
    : undefined
  const durationSeconds = (() => {
    const infoCandidates = [
      ...(infoElement
        ? [{ position: Math.max(0, infoElement.startOffset - segment.bodyOffset), sourceRank: 0, duration: directDurationSeconds }]
        : []),
      ...seekHeadTargets.infoPositions.map((position) => ({ position, sourceRank: 1, duration: undefined as number | null | undefined })),
      ...topLevelTargets.infoPositions.map((position) => ({ position, sourceRank: 2, duration: undefined as number | null | undefined })),
    ].sort((left, right) => left.position - right.position || left.sourceRank - right.sourceRank)

    let resolvedDuration: number | null = null
    let resolvedDurationPosition: number | null = null
    for (const candidate of infoCandidates) {
      const candidateResult = candidate.sourceRank === 0
        ? candidate.duration
        : (() => {
            const seekTarget = readMatroskaSeekTargetElement(filePath, fileBytes, segment, candidate.position, MATROSKA_INFO_ID)
            if (!seekTarget) {
              return undefined
            }
            return parseMatroskaBoundedInfoMetadata(seekTarget.buffer, seekTarget.element)
          })()
      if (candidateResult === undefined) {
        continue
      }
      resolvedDuration = resolvedDurationPosition !== null && candidate.position === resolvedDurationPosition
        ? candidateResult ?? resolvedDuration
        : candidateResult
      resolvedDurationPosition = candidate.position
    }
    return resolvedDuration
  })()
  const directTrackMetadata = tracksElement
    ? parseMatroskaBoundedTracksMetadata(head, tracksElement)
    : undefined
  const trackMetadata = (() => {
    const trackCandidates = [
      ...(tracksElement
        ? [{ position: Math.max(0, tracksElement.startOffset - segment.bodyOffset), sourceRank: 0, metadata: directTrackMetadata }]
        : []),
      ...seekHeadTargets.tracksPositions.map((position) => ({
        position,
        sourceRank: 1,
        metadata: null as { width: number | null, height: number | null, audioSampleRate: number | null, audioChannelCount: number | null } | null,
      })),
      ...topLevelTargets.tracksPositions.map((position) => ({
        position,
        sourceRank: 2,
        metadata: null as { width: number | null, height: number | null, audioSampleRate: number | null, audioChannelCount: number | null } | null,
      })),
    ].sort((left, right) => left.position - right.position || left.sourceRank - right.sourceRank)

    let resolvedTrackMetadata: { width: number | null, height: number | null, audioSampleRate: number | null, audioChannelCount: number | null } = {
      width: null,
      height: null,
      audioSampleRate: null,
      audioChannelCount: null,
    }
    let resolvedTrackPosition: number | null = null
    for (const candidate of trackCandidates) {
      const candidateMetadata = candidate.sourceRank === 0
        ? candidate.metadata
        : (() => {
            const seekTarget = readMatroskaSeekTargetElement(filePath, fileBytes, segment, candidate.position, MATROSKA_TRACKS_ID)
            if (!seekTarget) {
              return undefined
            }
            return parseMatroskaBoundedTracksMetadata(seekTarget.buffer, seekTarget.element)
          })()
      if (!candidateMetadata) {
        continue
      }
      resolvedTrackMetadata = resolvedTrackPosition !== null && candidate.position === resolvedTrackPosition
        ? {
            width: candidateMetadata.width ?? resolvedTrackMetadata.width,
            height: candidateMetadata.height ?? resolvedTrackMetadata.height,
            audioSampleRate: candidateMetadata.audioSampleRate ?? resolvedTrackMetadata.audioSampleRate,
            audioChannelCount: candidateMetadata.audioChannelCount ?? resolvedTrackMetadata.audioChannelCount,
          }
        : candidateMetadata
      resolvedTrackPosition = candidate.position
    }
    return resolvedTrackMetadata
  })()

  return {
    ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
    ...(trackMetadata.width ? { video_width_px: trackMetadata.width } : {}),
    ...(trackMetadata.height ? { video_height_px: trackMetadata.height } : {}),
    ...(trackMetadata.audioSampleRate ? { audio_sample_rate_hz: trackMetadata.audioSampleRate } : {}),
    ...(trackMetadata.audioChannelCount ? { audio_channel_count: trackMetadata.audioChannelCount } : {}),
  }
}

function extractAacAdtsMetadata(filePath: string, fileBytes: number | undefined): Record<string, number> {
  if (!fileBytes || fileBytes < 7) {
    return {}
  }

  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, 'r')
    const headerBuffer = Buffer.alloc(9)
    let offset = 0
    let totalSamples = 0
    let firstHeader: AacAdtsHeader | null = null
    let completeFrameSequence = true
    while (offset + 7 <= fileBytes) {
      const bytesRead = readSync(descriptor, headerBuffer, 0, headerBuffer.length, offset)
      if (bytesRead < 7) {
        completeFrameSequence = false
        break
      }

      const header = parseAacAdtsHeader(headerBuffer.subarray(0, bytesRead))
      if (!header) {
        completeFrameSequence = false
        break
      }

      if (!firstHeader) {
        firstHeader = header
      } else if (header.sampleRate !== firstHeader.sampleRate || header.channelCount !== firstHeader.channelCount) {
        completeFrameSequence = false
        break
      }

      if (offset + header.frameLength > fileBytes) {
        completeFrameSequence = false
        break
      }

      totalSamples += header.sampleCount
      offset += header.frameLength
    }

    if (!firstHeader) {
      return {}
    }

    const durationSeconds =
      completeFrameSequence && totalSamples > 0 && offset === fileBytes
        ? roundDurationSeconds(totalSamples / firstHeader.sampleRate)
        : null
    return {
      audio_sample_rate_hz: firstHeader.sampleRate,
      audio_channel_count: firstHeader.channelCount,
      ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
    }
  } catch {
    return {}
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore close failures for best-effort metadata reads.
      }
    }
  }
}

function extractOggAudioMetadata(filePath: string, fileBytes: number | undefined): Record<string, string | number> {
  if (!fileBytes || fileBytes < 27) {
    return {}
  }

  const head = readFileWindow(filePath, 0, Math.min(fileBytes, OGG_METADATA_SCAN_BYTES))
  if (!head || head.length < 27 || head.toString('ascii', 0, 4) !== 'OggS') {
    return {}
  }

  const audioHead = findSupportedOggAudioHead(head)
  if (!audioHead) {
    return {}
  }

  const firstPacket = audioHead.packets[0]
  if (!firstPacket) {
    return {}
  }

  const finalGranulePosition = findLastOggPageGranulePosition(filePath, fileBytes, audioHead.bitstreamSerialNumber)
  const vorbisIdentification = parseVorbisIdentificationPacket(firstPacket)
  if (vorbisIdentification) {
    const { sampleRate, channelCount } = vorbisIdentification
    const durationSeconds = finalGranulePosition !== null
      ? roundDurationSeconds(Number(finalGranulePosition) / sampleRate)
      : null
    return {
      ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
      audio_sample_rate_hz: sampleRate,
      audio_channel_count: channelCount,
      ...parseVorbisCommentPacket(audioHead.packets[1] ?? Buffer.alloc(0)),
    }
  }

  const opusHead = parseOpusHeadPacket(firstPacket)
  if (!opusHead) {
    return {}
  }

  const decodedSamples = finalGranulePosition !== null
    ? Number(finalGranulePosition > BigInt(opusHead.preSkip) ? finalGranulePosition - BigInt(opusHead.preSkip) : 0n)
    : null
  const durationSeconds = decodedSamples !== null ? roundDurationSeconds(decodedSamples / 48_000) : null
  return {
    ...(durationSeconds !== null ? { media_duration_seconds: durationSeconds } : {}),
    audio_sample_rate_hz: opusHead.sampleRate,
    audio_channel_count: opusHead.channelCount,
    ...parseOpusTagsPacket(audioHead.packets[1] ?? Buffer.alloc(0)),
  }
}

function extractBinaryTrackMetadata(
  filePath: string,
  extension: string,
  fileType: NonCodeFileType,
  fileBytes: number | undefined,
): Record<string, string> {
  if (fileType === 'audio' && extension === '.mp3') {
    return extractMp3Id3TrackMetadata(filePath, fileBytes)
  }

  return {}
}

function extractBinaryAudioMetadata(
  filePath: string,
  extension: string,
  fileType: NonCodeFileType,
  fileBytes: number | undefined,
): Record<string, string | number> {
  if (fileType !== 'audio') {
    return {}
  }

  if (extension === '.flac') {
    return extractFlacAudioMetadata(filePath, fileBytes)
  }

  if (extension === '.aac') {
    return extractAacAdtsMetadata(filePath, fileBytes)
  }

  if (MP4_FAMILY_EXTENSIONS.has(extension)) {
    return extractMp4AudioMetadata(filePath, fileBytes)
  }

  if (extension === '.ogg' || extension === '.opus') {
    return extractOggAudioMetadata(filePath, fileBytes)
  }

  return {}
}

function extractBinaryVideoMetadata(
  filePath: string,
  extension: string,
  fileType: NonCodeFileType,
  fileBytes: number | undefined,
): Record<string, number> {
  if (fileType !== 'video') {
    return {}
  }

  if (MP4_FAMILY_EXTENSIONS.has(extension)) {
    return extractMp4VideoMetadata(filePath, fileBytes)
  }

  if (extension === '.avi') {
    return extractAviVideoMetadata(filePath, fileBytes)
  }

  if (MATROSKA_FAMILY_EXTENSIONS.has(extension)) {
    return extractMatroskaVideoMetadata(filePath, fileBytes)
  }

  return {}
}

function applyDerivedIngestProvenance<T extends ProvenanceBearingRecord>(records: readonly T[], derivedProvenance: ExtractionProvenance | null): T[] {
  if (!derivedProvenance) {
    return [...records]
  }

  return records.map((record) => ({
    ...record,
    provenance: appendDerivedProvenance(record.provenance ?? [], derivedProvenance),
  }))
}

function finalizeNonCodeFragment(fragment: ExtractionFragment): ExtractionFragment {
  // Non-code extractors add the file node first, then lift any source metadata onto that same node.
  const derivedIngestProvenance = fragment.nodes[0] ? deriveIngestProvenanceFromRecord(fragment.nodes[0]) : null

  return {
    nodes: applyDerivedIngestProvenance(fragment.nodes, derivedIngestProvenance),
    edges: applyDerivedIngestProvenance(fragment.edges, derivedIngestProvenance),
  }
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

type NonCodeFileType = Extract<ExtractionNode['file_type'], 'document' | 'paper' | 'image' | 'audio' | 'video'>

const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_H1_PATTERN = /^={3,}\s*$/
const SETEXT_H2_PATTERN = /^-{3,}\s*$/
const LOCAL_LINK_PATTERN = /(!)?\[[^\]]{0,2048}\]\(([^)]{1,2048})\)/g
const PDF_METADATA_TITLE_PATTERN = /\/Title\s*\(([^)]{1,300})\)/i
const PDF_METADATA_AUTHOR_PATTERN = /\/Author\s*\(([^)]{1,300})\)/i
const PDF_METADATA_SUBJECT_PATTERN = /\/Subject\s*\(([^)]{1,300})\)/i
const PDF_TEXT_OPERATOR_PATTERN = /\((?:\\.|[^()\\]){1,2000}\)\s*Tj/g
const PDF_TEXT_ARRAY_OPERATOR_PATTERN = /\[((?:\\.|[^\]\\]){1,4000})\]\s*TJ/g
const PDF_COMMON_SECTION_LABELS = new Set([
  'abstract',
  'introduction',
  'background',
  'method',
  'methods',
  'approach',
  'results',
  'discussion',
  'conclusion',
  'conclusions',
  'references',
])
const DOCX_TEXT_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/w:t>/g
const XLSX_TEXT_PATTERN = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/(?:\w+:)?t>/g
const AVI_METADATA_SCAN_BYTES = 262_144
const BINARY_METADATA_HEADER_BYTES = 65_536
const AAC_SAMPLES_PER_RAW_BLOCK = 1_024
const FLAC_METADATA_SCAN_BYTES = 262_144
const MATROSKA_METADATA_SCAN_BYTES = 524_288
const MATROSKA_TOP_LEVEL_SCAN_BYTES = 1_048_576
const MATROSKA_SEEK_TARGET_SCAN_BYTES = 1_048_576
const MP3_ID3_SCAN_BYTES = 262_144
const MP4_DURATION_SCAN_BYTES = 262_144
const OGG_METADATA_SCAN_BYTES = 524_288
const OGG_PAGE_SCAN_OVERLAP_BYTES = 65_536
const OGG_TAIL_SCAN_BYTES = 262_144
const AAC_SAMPLE_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]
const MP4_TITLE_METADATA_BOX_TYPE = Buffer.from([0xa9, 0x6e, 0x61, 0x6d])
const MP4_ARTIST_METADATA_BOX_TYPE = Buffer.from([0xa9, 0x41, 0x52, 0x54])
const MP4_ALBUM_METADATA_BOX_TYPE = Buffer.from([0xa9, 0x61, 0x6c, 0x62])
const MATROSKA_MAX_SEEK_TARGETS_PER_TYPE = 8
const MATROSKA_DEFAULT_TIMECODE_SCALE_NS = 1_000_000
const MATROSKA_EBML_HEADER_ID = 0x1a45dfa3
const MATROSKA_SEGMENT_ID = 0x18538067
const MATROSKA_SEEK_HEAD_ID = 0x114d9b74
const MATROSKA_SEEK_ENTRY_ID = 0x4dbb
const MATROSKA_SEEK_ID_ID = 0x53ab
const MATROSKA_SEEK_POSITION_ID = 0x53ac
const MATROSKA_INFO_ID = 0x1549a966
const MATROSKA_VOID_ID = 0xec
const MATROSKA_TIMECODE_SCALE_ID = 0x2ad7b1
const MATROSKA_DURATION_ID = 0x4489
const MATROSKA_TRACKS_ID = 0x1654ae6b
const MATROSKA_TRACK_ENTRY_ID = 0xae
const MATROSKA_TRACK_TYPE_ID = 0x83
const MATROSKA_VIDEO_ID = 0xe0
const MATROSKA_AUDIO_ID = 0xe1
const MATROSKA_PIXEL_WIDTH_ID = 0xb0
const MATROSKA_PIXEL_HEIGHT_ID = 0xba
const MATROSKA_SAMPLING_FREQUENCY_ID = 0xb5
const MATROSKA_CHANNELS_ID = 0x9f
const BINARY_CONTENT_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.wav', 'audio/wav'],
  ['.avi', 'video/x-msvideo'],
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])
const MATROSKA_FAMILY_EXTENSIONS = new Set(['.mkv', '.webm'])
const MP4_FAMILY_EXTENSIONS = new Set(['.m4a', '.m4v', '.mov', '.mp4'])
const OOXML_TITLE_PATTERN = /<dc:title>([\s\S]*?)<\/dc:title>/i
const OOXML_CREATOR_PATTERN = /<dc:creator>([\s\S]*?)<\/dc:creator>/i
const OOXML_SUBJECT_PATTERN = /<dc:subject>([\s\S]*?)<\/dc:subject>/i
const OOXML_DESCRIPTION_PATTERN = /<dc:description>([\s\S]*?)<\/dc:description>/i
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[\s\S]{0,65536}?<\/w:p>/g
const DOCX_PARAGRAPH_STYLE_PATTERN = /<w:pStyle[^>]*w:val="([^"]+)"[^>]*\/>/i
const DOCX_MAX_COMPRESSED_ENTRY_BYTES = 2_097_152
const DOCX_MAX_ENTRY_ORIGINAL_BYTES = 4_194_304
const DOCX_MAX_TOTAL_ORIGINAL_BYTES = 6_291_456
const DOCX_MAX_PARAGRAPHS = 5_000
const DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH = 256
const DOCX_MAX_PARAGRAPH_TEXT_CHARS = 32_768
const XLSX_SHEET_PATTERN = /<sheet\b[^>]*name="([^"]{1,256})"[^>]*\/?/gi
const XLSX_SHARED_STRING_ITEM_PATTERN = /<si\b[\s\S]{0,65536}?<\/si>/g
const DOI_CITATION_PATTERN = /\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/gi
const ARXIV_CITATION_PATTERN = /(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/gi
const LATEX_CITATION_PATTERN = /\\cite\w{0,20}\{([^}]{1,512})\}/g
const MAX_REFERENCE_LABEL_CHARS = 220
const MAX_CITATION_KEYS_PER_LINE = 16
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])
const REFERENCE_URL_PATTERN = /\bhttps?:\/\/[^\s<>"']{4,400}/i
const MAX_STRUCTURED_TEXT_LINES = 100_000

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) {
    return trimmed
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\(["'])/g, '$1')
  }

  return trimmed
}

function parseFrontmatterList(value: string): string[] {
  const inner = value.trim().slice(1, -1)
  const entries: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (!character) {
      continue
    }

    if (quote) {
      if (character === '\\' && index + 1 < inner.length) {
        current += inner[index + 1] ?? ''
        index += 1
        continue
      }

      if (character === quote) {
        quote = null
        continue
      }

      current += character
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === ',') {
      const parsed = parseFrontmatterScalar(current)
      if (parsed) {
        entries.push(parsed)
      }
      current = ''
      continue
    }

    current += character
  }

  const parsed = parseFrontmatterScalar(current)
  if (parsed) {
    entries.push(parsed)
  }

  return entries
}

function parseFrontmatterValue(rawValue: string): string | string[] {
  const trimmed = rawValue.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFrontmatterList(trimmed)
  }

  return parseFrontmatterScalar(trimmed)
}

function parseStructuredTextFrontmatter(lines: string[]): { metadata: Record<string, unknown>; contentStartIndex: number } {
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, contentStartIndex: 0 }
  }

  const metadata: Record<string, unknown> = {}
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (trimmed === '---') {
      return { metadata, contentStartIndex: index + 1 }
    }

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }

    metadata[key] = parseFrontmatterValue(line.slice(separatorIndex + 1))
  }

  return { metadata, contentStartIndex: lines.length }
}

function normalizeSectionLabel(label: string): string {
  return sanitizeLabel(
    label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\*_`~]/g, '')
      .trim(),
  )
}

function sectionNodeId(filePath: string, label: string, line: number): string {
  return _makeId(fileStemForPath(filePath), label, String(line))
}

function parseMarkdownHeading(lines: string[], index: number): { level: number; text: string; consumedLines: number } | null {
  const currentLine = lines[index]?.trim() ?? ''
  if (!currentLine) {
    return null
  }

  const atxMatch = currentLine.match(MARKDOWN_HEADING_PATTERN)
  if (atxMatch?.[1] && atxMatch[2]) {
    const headingText = normalizeSectionLabel(atxMatch[2])
    if (!headingText) {
      return null
    }

    return {
      level: atxMatch[1].length,
      text: headingText,
      consumedLines: 1,
    }
  }

  const nextLine = lines[index + 1]?.trim() ?? ''
  if (!nextLine) {
    return null
  }

  if (SETEXT_H1_PATTERN.test(nextLine)) {
    return {
      level: 1,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  if (SETEXT_H2_PATTERN.test(nextLine)) {
    return {
      level: 2,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  return null
}

function targetNodeId(targetPath: string): string {
  return fileNodeIdForPath(targetPath)
}

function isExternalReference(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)
}

function cleanReferenceTarget(rawTarget: string): string {
  return rawTarget.trim().replace(/^<|>$/g, '').split('#')[0]?.split('?')[0] ?? ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addCorpusReferenceEdge(
  edges: ExtractionEdge[],
  sourceId: string,
  targetPath: string,
  relation: 'references' | 'embeds',
  filePath: string,
  lineNumber: number,
  seenEdges?: Set<string>,
): void {
  const targetId = targetNodeId(targetPath)
  if (sourceId === targetId) {
    return
  }

  const edge = createEdge(sourceId, targetId, relation, filePath, lineNumber)
  if (seenEdges) {
    addUniqueEdge(edges, seenEdges, edge)
    return
  }

  addEdge(edges, edge)
}

function addLocalReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  for (const match of line.matchAll(LOCAL_LINK_PATTERN)) {
    const isImage = Boolean(match[1])
    const rawTarget = match[2]
    if (!rawTarget || isExternalReference(rawTarget)) {
      continue
    }

    const cleanedTarget = cleanReferenceTarget(rawTarget)
    if (!cleanedTarget) {
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), cleanedTarget)
    if (!allowedTargets.has(resolvedTarget) || !existsSync(resolvedTarget)) {
      continue
    }

    const relationTargetType = classifyFile(resolvedTarget)
    if (!relationTargetType) {
      continue
    }

    const relation = isImage || relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, resolvedTarget, relation, filePath, lineNumber, seenEdges)
  }
}

function addMentionReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  const normalizedLine = line.toLowerCase()

  for (const targetPath of allowedTargets) {
    if (resolve(targetPath) === resolve(filePath) || !existsSync(targetPath)) {
      continue
    }

    const relationTargetType = classifyFile(targetPath)
    if (!relationTargetType) {
      continue
    }

    const targetName = basename(targetPath).toLowerCase()
    if (!targetName) {
      continue
    }

    const mentionPattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(targetName)}(?=[^a-z0-9_]|$)`, 'i')
    if (!mentionPattern.test(normalizedLine)) {
      continue
    }

    const relation = relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, targetPath, relation, filePath, lineNumber, seenEdges)
  }
}

function trimCitationValue(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '')
}

function citationSourceUrl(kind: 'doi' | 'arxiv' | 'citation_key', value: string): string | null {
  if (kind === 'doi') {
    return `https://doi.org/${value}`
  }

  if (kind === 'arxiv') {
    return `https://arxiv.org/abs/${value}`
  }

  return null
}

function trimReferenceSourceUrl(value: string): string {
  return value.trim().replace(/[),.;:\]]+$/g, '')
}

function explicitReferenceSourceUrl(summary: string): string | null {
  const rawUrl = summary.match(REFERENCE_URL_PATTERN)?.[0]
  if (!rawUrl) {
    return null
  }

  const normalizedUrl = trimReferenceSourceUrl(rawUrl)
  if (!normalizedUrl) {
    return null
  }

  try {
    const parsedUrl = new URL(normalizedUrl)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null
    }

    return parsedUrl.toString()
  } catch {
    return null
  }
}

function stripInlineCodeSpans(text: string): string {
  return text.replace(/`[^`\n]{1,200}`/g, ' ')
}

function createSemanticPaperNode(
  id: string,
  label: string,
  sourceFile: string,
  line: number,
  semanticKind: 'citation' | 'reference',
  extra: Record<string, unknown> = {},
): ExtractionNode {
  return {
    ...createNode(id, label, sourceFile, line, 'paper'),
    virtual: true,
    semantic_kind: semanticKind,
    ...extra,
  }
}

function addPaperCitationNode(
  nodes: ExtractionNode[],
  seenIds: Set<string>,
  kind: 'doi' | 'arxiv' | 'citation_key',
  value: string,
  filePath: string,
  lineNumber: number,
): string | null {
  const normalizedValue = trimCitationValue(value)
  if (!normalizedValue) {
    return null
  }

  const label = kind === 'doi' ? `DOI:${normalizedValue}` : kind === 'arxiv' ? `arXiv:${normalizedValue}` : `cite:${normalizedValue}`
  const nodeId = _makeId('citation', kind, normalizedValue)
  const sourceUrl = citationSourceUrl(kind, normalizedValue)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(nodeId, label, filePath, lineNumber, 'citation', {
      citation_kind: kind,
      citation_value: normalizedValue,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    }),
  )
  return nodeId
}

function parseInlineReferenceCitationIndices(text: string): number[] {
  const citationText = stripInlineCodeSpans(text)
  if (/^\[(\d{1,3})\]\s+/.test(citationText.trim())) {
    return []
  }

  const indices: number[] = []
  const seen = new Set<number>()
  for (const match of citationText.matchAll(/\[(\d{1,3}(?:\s*(?:,|-)\s*\d{1,3})*)\](?!\()/g)) {
    const rawBlock = match[1]
    if (!rawBlock) {
      continue
    }

    for (const rawPart of rawBlock.split(',')) {
      const part = rawPart.trim()
      if (!part) {
        continue
      }

      if (part.includes('-')) {
        const [startPart, endPart] = part.split('-', 2)
        const startRaw = startPart ? Number.parseInt(startPart.trim(), 10) : Number.NaN
        const endRaw = endPart ? Number.parseInt(endPart.trim(), 10) : Number.NaN
        if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw) || startRaw < 1 || endRaw < startRaw) {
          continue
        }

        for (let index = startRaw; index <= endRaw && indices.length < 32; index += 1) {
          if (seen.has(index)) {
            continue
          }
          seen.add(index)
          indices.push(index)
        }
        continue
      }

      const referenceIndex = Number.parseInt(part, 10)
      if (!Number.isFinite(referenceIndex) || referenceIndex < 1 || seen.has(referenceIndex)) {
        continue
      }

      seen.add(referenceIndex)
      indices.push(referenceIndex)
      if (indices.length >= 32) {
        break
      }
    }
  }

  return indices
}

function addInlineReferenceCitationEdgesFromText(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: PendingReferenceCitation[],
): void {
  const unresolvedIndices: number[] = []
  for (const referenceIndex of parseInlineReferenceCitationIndices(text)) {
    const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
    if (referenceNodeId) {
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, referenceNodeId, 'cites', filePath, lineNumber))
      continue
    }
    unresolvedIndices.push(referenceIndex)
  }

  if (unresolvedIndices.length > 0) {
    pendingReferenceCitations.push({ sourceId, lineNumber, referenceIndices: unresolvedIndices })
  }
}

function flushPendingReferenceCitations(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  filePath: string,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: readonly PendingReferenceCitation[],
): void {
  for (const pending of pendingReferenceCitations) {
    for (const referenceIndex of pending.referenceIndices) {
      const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
      if (!referenceNodeId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(pending.sourceId, referenceNodeId, 'cites', filePath, pending.lineNumber))
    }
  }
}

function parseNumberedReferenceEntry(text: string): { rawIndex: string; referenceIndex: number; summary: string } | null {
  const normalizedText = text.trim()
  const match = normalizedText.match(/^\[(\d{1,3})\]\s+(.{1,400})$/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  const referenceIndex = Number.parseInt(match[1], 10)
  if (Number.isNaN(referenceIndex) || referenceIndex < 1 || referenceIndex > 999) {
    return null
  }

  const summary = sanitizeLabel(match[2].replace(/\s+/g, ' ').trim()).slice(0, MAX_REFERENCE_LABEL_CHARS)
  if (!summary) {
    return null
  }

  return { rawIndex: match[1], referenceIndex, summary }
}

function parseReferenceMetadata(summary: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const doi = summary.match(/\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/i)?.[0]
  const arxivId = summary.match(/(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/i)?.[1]
  const referenceUrl = explicitReferenceSourceUrl(summary)
  const yearMatch = summary.match(/\b(19|20)\d{2}\b/)

  if (doi) {
    metadata.doi = trimCitationValue(doi)
    metadata.source_url = citationSourceUrl('doi', trimCitationValue(doi))
  }
  if (arxivId) {
    metadata.arxiv_id = trimCitationValue(arxivId)
    metadata.source_url ??= citationSourceUrl('arxiv', trimCitationValue(arxivId))
  }
  if (referenceUrl) {
    metadata.source_url ??= referenceUrl
  }
  if (yearMatch?.[0]) {
    const parsedYear = Number.parseInt(yearMatch[0], 10)
    if (Number.isFinite(parsedYear)) {
      metadata.reference_year = parsedYear
    }

    const authors = sanitizeLabel(summary.slice(0, yearMatch.index ?? 0).replace(/[\s.,;:-]+$/g, ''))
    if (authors) {
      metadata.reference_authors = authors
    }

    const titleSource = summary
      .slice((yearMatch.index ?? 0) + yearMatch[0].length)
      .replace(/^[\])}.:;\s-]+/, '')
      .replace(/\b(?:doi|arxiv)\s*:?[\s\S]*$/i, '')
      .trim()
    const title = sanitizeLabel(titleSource.split(/\.(?:\s|$)/, 1)[0] ?? '')
    if (title) {
      metadata.reference_title = title
    }
  }

  return metadata
}

function addCitationEdgesFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
): void {
  const citationText = stripInlineCodeSpans(text)

  for (const match of citationText.matchAll(DOI_CITATION_PATTERN)) {
    const doi = match[0]
    if (!doi) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'doi', doi, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(ARXIV_CITATION_PATTERN)) {
    const arxivId = match[1]
    if (!arxivId) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'arxiv', arxivId, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(LATEX_CITATION_PATTERN)) {
    const rawKeys = match[1]
    if (!rawKeys) {
      continue
    }

    for (const key of rawKeys
      .split(',')
      .map((value) => trimCitationValue(value))
      .filter(Boolean)
      .slice(0, MAX_CITATION_KEYS_PER_LINE)) {
      const citationId = addPaperCitationNode(nodes, seenIds, 'citation_key', key, filePath, lineNumber)
      if (!citationId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
    }
  }
}

function addReferenceNodeFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  filePath: string,
  lineNumber: number,
  containerId: string,
): string | null {
  const entry = parseNumberedReferenceEntry(text)
  if (!entry) {
    return null
  }

  const referenceId = _makeId(fileStemForPath(filePath), 'reference', entry.rawIndex)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(referenceId, `[${entry.rawIndex}] ${entry.summary}`, filePath, lineNumber, 'reference', {
      reference_index: entry.referenceIndex,
      ...parseReferenceMetadata(entry.summary),
    }),
  )
  addUniqueEdge(edges, seenEdges, createEdge(containerId, referenceId, 'contains', filePath, lineNumber))
  return referenceId
}

export function createCodeFileOnlyExtraction(filePath: string): ExtractionFragment {
  return {
    nodes: [createFileNode(filePath, 'code')],
    edges: [],
  }
}

export function ensureTextFileWithinLimit(filePath: string): boolean {
  try {
    return statSync(filePath).size <= MAX_TEXT_BYTES
  } catch {
    return false
  }
}

const documentExtractionHelpers = {
  createFileNode,
  createBinaryMetadataAwareFileNode,
  finalizeNonCodeFragment,
  addNode,
  addEdge,
  createNode,
  createEdge,
  normalizeLabel,
  sectionNodeId,
  parseStructuredTextFrontmatter,
  parseMarkdownHeading,
  addLocalReferenceEdges,
  addMentionReferenceEdges,
  parseNumberedReferenceEntry,
  addReferenceNodeFromText,
  addCitationEdgesFromText,
  addInlineReferenceCitationEdgesFromText,
  flushPendingReferenceCitations,
}

const pdfExtractionHelpers = {
  createBinaryMetadataAwareFileNode,
  finalizeNonCodeFragment,
  addNode,
  addEdge,
  createNode,
  createEdge,
  normalizeLabel,
  sectionNodeId,
  parseNumberedReferenceEntry,
  addReferenceNodeFromText,
  addCitationEdgesFromText,
  addMentionReferenceEdges,
  addInlineReferenceCitationEdgesFromText,
  flushPendingReferenceCitations,
}

export function extractCompareBaselineNonCodeText(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase()
  const extractedText =
    extension === '.pdf'
      ? extractCompareBaselinePdfTextModule(filePath)
      : extension === '.docx'
        ? extractCompareBaselineDocxTextModule(filePath)
        : extension === '.xlsx'
          ? extractCompareBaselineXlsxTextModule(filePath)
          : null

  if (extractedText === null) {
    return null
  }

  const normalizedText = extractedText.trimEnd()
  if (!normalizedText) {
    throw new Error(`Compare baseline could not extract text from graph-backed file: ${filePath}`)
  }

  return normalizedText
}

function extractBinaryAsset(filePath: string, fileType: Extract<NonCodeFileType, 'image' | 'audio' | 'video'>): ExtractionFragment {
  return finalizeNonCodeFragment({
    nodes: [createBinaryMetadataAwareFileNode(filePath, fileType)],
    edges: [],
  })
}
export function extractPaper(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.pdf') {
    return extractPdfPaperModule(filePath, allowedTargets, pdfExtractionHelpers)
  }

  return extractStructuredTextModule(filePath, 'paper', allowedTargets, documentExtractionHelpers)
}

export function extractDocument(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.docx') {
    return extractDocxDocumentModule(filePath, allowedTargets, documentExtractionHelpers)
  }
  if (extension === '.xlsx') {
    return extractXlsxDocumentModule(filePath, allowedTargets, documentExtractionHelpers)
  }

  return extractStructuredTextModule(filePath, 'document', allowedTargets, documentExtractionHelpers)
}

export function extractImageFile(filePath: string): ExtractionFragment {
  return extractBinaryAsset(filePath, 'image')
}

export function extractAudioFile(filePath: string): ExtractionFragment {
  return extractBinaryAsset(filePath, 'audio')
}

export function extractVideoFile(filePath: string): ExtractionFragment {
  return extractBinaryAsset(filePath, 'video')
}
