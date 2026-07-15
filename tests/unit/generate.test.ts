import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph, GenerateUnsupportedCorpusError } from '../../src/infrastructure/generate.js'
import { analyzeImpact, callChains } from '../../src/runtime/impact.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { binaryIngestSidecarPath } from '../../src/shared/binary-ingest-sidecar.js'
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-generate-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function withTempDirAsync<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-generate-'))
  try {
    return await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function copyFixtureCorpus(fixtureName: string, tempDir: string): string {
  const fixtureRoot = join(FIXTURES_DIR, fixtureName)
  const targetRoot = join(tempDir, fixtureName)
  cpSync(fixtureRoot, targetRoot, { recursive: true })
  return targetRoot
}

function createTestWavBuffer(durationSeconds: number, sampleRate: number = 4_000, channelCount: number = 2, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channelCount * (bitsPerSample / 8)
  const blockAlign = channelCount * (bitsPerSample / 8)
  const dataSize = Math.round(durationSeconds * byteRate)
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channelCount, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function createMp4Atom(type: string, payload: Buffer): Buffer {
  const buffer = Buffer.alloc(8 + payload.length)
  buffer.writeUInt32BE(buffer.length, 0)
  buffer.write(type, 4, 'ascii')
  payload.copy(buffer, 8)
  return buffer
}

function createTestMp4Buffer(durationSeconds: number, timescale: number = 1_000): Buffer {
  const mvhdPayload = Buffer.alloc(20)
  mvhdPayload.writeUInt32BE(0, 0)
  mvhdPayload.writeUInt32BE(0, 4)
  mvhdPayload.writeUInt32BE(0, 8)
  mvhdPayload.writeUInt32BE(timescale, 12)
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * timescale), 16)

  return Buffer.concat([
    createMp4Atom('ftyp', Buffer.from('isom0000', 'ascii')),
    createMp4Atom('moov', createMp4Atom('mvhd', mvhdPayload)),
  ])
}

function createMp4AtomWithType(type: Buffer, payload: Buffer): Buffer {
  const buffer = Buffer.alloc(8 + payload.length)
  buffer.writeUInt32BE(buffer.length, 0)
  type.copy(buffer, 4)
  payload.copy(buffer, 8)
  return buffer
}

function createMp4AudioSampleEntry(sampleRate: number, channelCount: number, sampleEntryType: string = 'mp4a'): Buffer {
  const body = Buffer.alloc(28)
  body.writeUInt16BE(1, 6)
  body.writeUInt16BE(channelCount, 16)
  body.writeUInt16BE(16, 18)
  body.writeUInt32BE(sampleRate * 65_536, 24)
  return createMp4Atom(sampleEntryType, body)
}

function createMp4VideoSampleEntry(width: number, height: number, sampleEntryType: string = 'avc1'): Buffer {
  const body = Buffer.alloc(28)
  body.writeUInt16BE(1, 6)
  body.writeUInt16BE(width, 24)
  body.writeUInt16BE(height, 26)
  return createMp4Atom(sampleEntryType, body)
}

function createMp4StsdBox(entries: Buffer[]): Buffer {
  const payload = Buffer.alloc(8)
  payload.writeUInt32BE(0, 0)
  payload.writeUInt32BE(entries.length, 4)
  return createMp4Atom('stsd', Buffer.concat([payload, ...entries]))
}

function createMp4HandlerBox(handlerType: string): Buffer {
  const payload = Buffer.alloc(12)
  payload.write(handlerType, 8, 'ascii')
  return createMp4Atom('hdlr', payload)
}

function createMp4TrackHeaderBox(width: number, height: number): Buffer {
  const payload = Buffer.alloc(84)
  payload.writeUInt32BE(0x00000007, 0)
  payload.writeUInt32BE(1, 12)
  payload.writeUInt32BE(0, 20)
  payload.writeUInt16BE(0, 32)
  payload.writeUInt16BE(0, 34)
  payload.writeUInt16BE(0x0100, 36)
  payload.writeUInt32BE(0x00010000, 40)
  payload.writeUInt32BE(0, 44)
  payload.writeUInt32BE(0, 48)
  payload.writeUInt32BE(0, 52)
  payload.writeUInt32BE(0x00010000, 56)
  payload.writeUInt32BE(0, 60)
  payload.writeUInt32BE(0, 64)
  payload.writeUInt32BE(0, 68)
  payload.writeUInt32BE(0x40000000, 72)
  payload.writeUInt32BE(width * 65_536, 76)
  payload.writeUInt32BE(height * 65_536, 80)
  return createMp4Atom('tkhd', payload)
}

function createMp4MediaHeaderBox(durationSeconds: number, timescale: number = 1_000): Buffer {
  const payload = Buffer.alloc(24)
  payload.writeUInt32BE(0, 0)
  payload.writeUInt32BE(0, 4)
  payload.writeUInt32BE(0, 8)
  payload.writeUInt32BE(timescale, 12)
  payload.writeUInt32BE(Math.round(durationSeconds * timescale), 16)
  payload.writeUInt16BE(0, 20)
  payload.writeUInt16BE(0, 22)
  return createMp4Atom('mdhd', payload)
}

function createMp4TrackBox(
  handlerType: string,
  stsd: Buffer,
  options: {
    tkhd?: Buffer | null
    mdhd?: Buffer | null
  } = {},
): Buffer {
  return createMp4Atom(
    'trak',
    Buffer.concat([
      ...(options.tkhd ? [options.tkhd] : []),
      createMp4Atom(
        'mdia',
        Buffer.concat([
          ...(options.mdhd ? [options.mdhd] : []),
          createMp4HandlerBox(handlerType),
          createMp4Atom('minf', createMp4Atom('stbl', stsd)),
        ]),
      ),
    ]),
  )
}

function createMp4MetadataDataAtom(value: string): Buffer {
  const payload = Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]),
    Buffer.from(value, 'utf8'),
  ])
  return createMp4Atom('data', payload)
}

function createMp4MetadataItem(typeBytes: Buffer, value: string): Buffer {
  return createMp4AtomWithType(typeBytes, createMp4MetadataDataAtom(value))
}

function createTestM4aBuffer(
  metadata: { title: string; artist: string; album: string },
  options: { durationSeconds?: number; sampleRate?: number; channelCount?: number } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 2.5
  const sampleRate = options.sampleRate ?? 48_000
  const channelCount = options.channelCount ?? 2

  const mvhdPayload = Buffer.alloc(20)
  mvhdPayload.writeUInt32BE(0, 0)
  mvhdPayload.writeUInt32BE(0, 4)
  mvhdPayload.writeUInt32BE(0, 8)
  mvhdPayload.writeUInt32BE(1_000, 12)
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * 1_000), 16)

  const stsd = createMp4StsdBox([createMp4AudioSampleEntry(sampleRate, channelCount)])
  const trak = createMp4TrackBox('soun', stsd)
  const ilst = createMp4Atom('ilst', Buffer.concat([
    createMp4MetadataItem(Buffer.from([0xa9, 0x6e, 0x61, 0x6d]), metadata.title),
    createMp4MetadataItem(Buffer.from([0xa9, 0x41, 0x52, 0x54]), metadata.artist),
    createMp4MetadataItem(Buffer.from([0xa9, 0x61, 0x6c, 0x62]), metadata.album),
  ]))
  const meta = createMp4Atom('meta', Buffer.concat([Buffer.alloc(4), ilst]))
  const udta = createMp4Atom('udta', meta)

  return Buffer.concat([
    createMp4Atom('ftyp', Buffer.from('M4A 0000', 'ascii')),
    createMp4Atom('moov', Buffer.concat([createMp4Atom('mvhd', mvhdPayload), trak, udta])),
  ])
}

function createTestVideoMp4Buffer(
  options: {
    durationSeconds?: number
    width?: number
    height?: number
    audioTrackFirst?: boolean
    truncateVideoSampleEntry?: boolean
    includeVideoTkhdDimensions?: boolean
    omitMovieHeaderDuration?: boolean
    includeTrackMdhdDuration?: boolean
  } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 2.5
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const audioTrackFirst = options.audioTrackFirst ?? true

  const mvhdPayload = Buffer.alloc(20)
  mvhdPayload.writeUInt32BE(0, 0)
  mvhdPayload.writeUInt32BE(0, 4)
  mvhdPayload.writeUInt32BE(0, 8)
  mvhdPayload.writeUInt32BE(1_000, 12)
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * 1_000), 16)

  const audioStsd = createMp4StsdBox([createMp4AudioSampleEntry(48_000, 2)])
  const videoEntry = options.truncateVideoSampleEntry
    ? createMp4VideoSampleEntry(width, height).subarray(0, createMp4VideoSampleEntry(width, height).length - 3)
    : createMp4VideoSampleEntry(width, height)
  const videoStsd = createMp4StsdBox([videoEntry])
  const audioTrak = createMp4TrackBox('soun', audioStsd, {
    mdhd: options.includeTrackMdhdDuration ? createMp4MediaHeaderBox(durationSeconds) : null,
  })
  const videoTrak = createMp4TrackBox(
    'vide',
    videoStsd,
    {
      tkhd: options.includeVideoTkhdDimensions ? createMp4TrackHeaderBox(width, height) : null,
      mdhd: options.includeTrackMdhdDuration ? createMp4MediaHeaderBox(durationSeconds) : null,
    },
  )

  return Buffer.concat([
    createMp4Atom('ftyp', Buffer.from('isom0000', 'ascii')),
    createMp4Atom(
      'moov',
      Buffer.concat([
        ...(options.omitMovieHeaderDuration ? [] : [createMp4Atom('mvhd', mvhdPayload)]),
        ...(audioTrackFirst ? [audioTrak, videoTrak] : [videoTrak, audioTrak]),
      ]),
    ),
  ])
}

const EBML_HEADER_ID = [0x1a, 0x45, 0xdf, 0xa3]
const EBML_DOC_TYPE_ID = [0x42, 0x82]
const EBML_SEGMENT_ID = [0x18, 0x53, 0x80, 0x67]
const EBML_SEEK_HEAD_ID = [0x11, 0x4d, 0x9b, 0x74]
const EBML_SEEK_ENTRY_ID = [0x4d, 0xbb]
const EBML_SEEK_ID_ID = [0x53, 0xab]
const EBML_SEEK_POSITION_ID = [0x53, 0xac]
const EBML_INFO_ID = [0x15, 0x49, 0xa9, 0x66]
const EBML_TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1]
const EBML_DURATION_ID = [0x44, 0x89]
const EBML_MUXING_APP_ID = [0x4d, 0x80]
const EBML_TRACKS_ID = [0x16, 0x54, 0xae, 0x6b]
const EBML_TRACK_ENTRY_ID = [0xae]
const EBML_TRACK_TYPE_ID = [0x83]
const EBML_VIDEO_ID = [0xe0]
const EBML_AUDIO_ID = [0xe1]
const EBML_VOID_ID = [0xec]
const EBML_PIXEL_WIDTH_ID = [0xb0]
const EBML_PIXEL_HEIGHT_ID = [0xba]
const EBML_SAMPLING_FREQUENCY_ID = [0xb5]
const EBML_CHANNELS_ID = [0x9f]

function encodeEbmlSize(value: number): Buffer {
  for (let length = 1; length <= 8; length += 1) {
    const maxValue = (2 ** (7 * length)) - 1
    if (value < maxValue) {
      const encoded = Buffer.alloc(length)
      let remaining = value
      for (let index = length - 1; index >= 1; index -= 1) {
        encoded[index] = remaining & 0xff
        remaining >>= 8
      }
      encoded[0] = (1 << (8 - length)) | remaining
      return encoded
    }
  }

  throw new Error(`Unsupported EBML size in test helper: ${value}`)
}

function encodeEbmlUnsigned(value: number): Buffer {
  if (value === 0) {
    return Buffer.from([0])
  }

  let remaining = value
  const bytes: number[] = []
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Buffer.from(bytes)
}

function createEbmlElement(id: readonly number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), encodeEbmlSize(payload.length), payload])
}

function createMalformedEbmlElement(id: readonly number[], payload: Buffer, declaredSize: number): Buffer {
  return Buffer.concat([Buffer.from(id), encodeEbmlSize(declaredSize), payload])
}

function createTruncatedEbmlElementHeader(id: readonly number[]): Buffer {
  return Buffer.concat([Buffer.from(id), Buffer.from([0x40])])
}

function createEbmlUnsignedElement(id: readonly number[], value: number): Buffer {
  return createEbmlElement(id, encodeEbmlUnsigned(value))
}

function createEbmlFloatElement(id: readonly number[], value: number): Buffer {
  const payload = Buffer.alloc(8)
  payload.writeDoubleBE(value, 0)
  return createEbmlElement(id, payload)
}

function createEbmlSeekEntry(targetId: readonly number[], position: number): Buffer {
  return createEbmlElement(EBML_SEEK_ENTRY_ID, Buffer.concat([
    createEbmlElement(EBML_SEEK_ID_ID, Buffer.from(targetId)),
    createEbmlUnsignedElement(EBML_SEEK_POSITION_ID, position),
  ]))
}

function createEbmlSeekHeadEntries(entries: Array<{ targetId: readonly number[], position: number }>): Buffer {
  return createEbmlElement(EBML_SEEK_HEAD_ID, Buffer.concat(entries.map((entry) => createEbmlSeekEntry(entry.targetId, entry.position))))
}

function createTestMatroskaBuffer(
  options: {
    docType?: 'webm' | 'matroska'
    durationSeconds?: number
    width?: number
    height?: number
    audioTrackFirst?: boolean
    omitDuration?: boolean
    malformedDuration?: boolean
    timecodeScale?: number
    includeAudioTrackMetadata?: boolean
    audioSampleRate?: number
    audioChannelCount?: number
    staleFirstInfoMetadata?: {
      durationSeconds: number
      timecodeScale?: number
    }
    prefixedSegmentBytes?: number
    interstitialSegmentBytes?: number
    prefixedInfoBytes?: number
    trailingInfoBytes?: number
    trailingInfoChildBytes?: number
    malformedTrailingInfoChildBytes?: number
    truncatedTrailingInfoChildHeader?: boolean
    prefixedTracksBytes?: number
    useSeekHead?: boolean
    splitSeekHeads?: boolean
    staleFirstInfoSeekHead?: boolean
    staleFirstTracksSeekHead?: boolean
    finalTracksAudioOnly?: boolean
    trailingTracksChildBytes?: number
    malformedTrailingTracksChildBytes?: number
    trailingTracksBytes?: number
    truncatedTrailingTracksChildHeader?: boolean
    staleFirstTracksMetadata?: {
      width: number
      height: number
      audioSampleRate: number
      audioChannelCount: number
    }
  } = {},
): Buffer {
  const docType = options.docType ?? 'webm'
  const durationSeconds = options.durationSeconds ?? 4.25
  const width = options.width ?? 1280
  const height = options.height ?? 720
  const audioTrackFirst = options.audioTrackFirst ?? true
  const timecodeScale = options.timecodeScale ?? 1_000_000
  const audioSampleRate = options.audioSampleRate ?? 48_000
  const audioChannelCount = options.audioChannelCount ?? 2
  const staleFirstInfoMetadata = options.staleFirstInfoMetadata
  const prefixedSegmentBytes = options.prefixedSegmentBytes ?? 0
  const interstitialSegmentBytes = options.interstitialSegmentBytes ?? 0
  const prefixedInfoBytes = options.prefixedInfoBytes ?? 0
  const trailingInfoBytes = options.trailingInfoBytes ?? 0
  const trailingInfoChildBytes = options.trailingInfoChildBytes ?? 0
  const malformedTrailingInfoChildBytes = options.malformedTrailingInfoChildBytes ?? 0
  const truncatedTrailingInfoChildHeader = options.truncatedTrailingInfoChildHeader ?? false
  const prefixedTracksBytes = options.prefixedTracksBytes ?? 0
  const trailingTracksBytes = options.trailingTracksBytes ?? 0
  const useSeekHead = options.useSeekHead ?? false
  const splitSeekHeads = options.splitSeekHeads ?? false
  const staleFirstInfoSeekHead = options.staleFirstInfoSeekHead ?? false
  const staleFirstTracksSeekHead = options.staleFirstTracksSeekHead ?? false
  const finalTracksAudioOnly = options.finalTracksAudioOnly ?? false
  const trailingTracksChildBytes = options.trailingTracksChildBytes ?? 0
  const malformedTrailingTracksChildBytes = options.malformedTrailingTracksChildBytes ?? 0
  const truncatedTrailingTracksChildHeader = options.truncatedTrailingTracksChildHeader ?? false
  const staleFirstTracksMetadata = options.staleFirstTracksMetadata

  const info = createEbmlElement(EBML_INFO_ID, Buffer.concat([
    ...(prefixedInfoBytes > 0 ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(prefixedInfoBytes))] : []),
    createEbmlUnsignedElement(EBML_TIMECODE_SCALE_ID, timecodeScale),
    ...(options.omitDuration
      ? []
      : [options.malformedDuration
          ? createEbmlElement(EBML_DURATION_ID, Buffer.from([0x40, 0x94, 0x00]))
          : createEbmlFloatElement(EBML_DURATION_ID, durationSeconds * 1_000)]),
    ...(trailingInfoChildBytes > 0 ? [createEbmlElement(EBML_MUXING_APP_ID, Buffer.alloc(trailingInfoChildBytes))] : []),
    ...(malformedTrailingInfoChildBytes > 0
      ? [createMalformedEbmlElement(
          EBML_MUXING_APP_ID,
          Buffer.alloc(malformedTrailingInfoChildBytes),
          malformedTrailingInfoChildBytes + 32,
        )]
      : []),
    ...(truncatedTrailingInfoChildHeader ? [createTruncatedEbmlElementHeader(EBML_MUXING_APP_ID)] : []),
    ...(trailingInfoBytes > 0 ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(trailingInfoBytes))] : []),
  ]))
  const staleInfo = staleFirstInfoMetadata
    ? createEbmlElement(EBML_INFO_ID, Buffer.concat([
        createEbmlUnsignedElement(EBML_TIMECODE_SCALE_ID, staleFirstInfoMetadata.timecodeScale ?? 1_000_000),
        createEbmlFloatElement(EBML_DURATION_ID, staleFirstInfoMetadata.durationSeconds * 1_000),
      ]))
    : null
  const videoTrackEntry = createEbmlElement(EBML_TRACK_ENTRY_ID, Buffer.concat([
    createEbmlUnsignedElement(EBML_TRACK_TYPE_ID, 1),
    createEbmlElement(EBML_VIDEO_ID, Buffer.concat([
      createEbmlUnsignedElement(EBML_PIXEL_WIDTH_ID, width),
      createEbmlUnsignedElement(EBML_PIXEL_HEIGHT_ID, height),
    ])),
  ]))
  const audioTrackEntry = createEbmlElement(EBML_TRACK_ENTRY_ID, Buffer.concat([
    createEbmlUnsignedElement(EBML_TRACK_TYPE_ID, 2),
    ...(options.includeAudioTrackMetadata
      ? [createEbmlElement(EBML_AUDIO_ID, Buffer.concat([
          createEbmlFloatElement(EBML_SAMPLING_FREQUENCY_ID, audioSampleRate),
          createEbmlUnsignedElement(EBML_CHANNELS_ID, audioChannelCount),
        ]))]
      : []),
  ]))
  const tracks = createEbmlElement(EBML_TRACKS_ID, Buffer.concat([
    ...(prefixedTracksBytes > 0 ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(prefixedTracksBytes))] : []),
    ...(finalTracksAudioOnly ? [audioTrackEntry] : audioTrackFirst ? [audioTrackEntry, videoTrackEntry] : [videoTrackEntry, audioTrackEntry]),
    ...(trailingTracksChildBytes > 0 ? [createEbmlElement(EBML_MUXING_APP_ID, Buffer.alloc(trailingTracksChildBytes))] : []),
    ...(malformedTrailingTracksChildBytes > 0
      ? [createMalformedEbmlElement(
          EBML_VOID_ID,
          Buffer.alloc(malformedTrailingTracksChildBytes),
          malformedTrailingTracksChildBytes + 32,
        )]
      : []),
    ...(truncatedTrailingTracksChildHeader ? [createTruncatedEbmlElementHeader(EBML_VOID_ID)] : []),
    ...(trailingTracksBytes > 0 ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(trailingTracksBytes))] : []),
  ]))
  const staleTracks = staleFirstTracksMetadata
    ? createEbmlElement(EBML_TRACKS_ID, Buffer.concat([
        createEbmlElement(EBML_TRACK_ENTRY_ID, Buffer.concat([
          createEbmlUnsignedElement(EBML_TRACK_TYPE_ID, 1),
          createEbmlElement(EBML_VIDEO_ID, Buffer.concat([
            createEbmlUnsignedElement(EBML_PIXEL_WIDTH_ID, staleFirstTracksMetadata.width),
            createEbmlUnsignedElement(EBML_PIXEL_HEIGHT_ID, staleFirstTracksMetadata.height),
          ])),
        ])),
        createEbmlElement(EBML_TRACK_ENTRY_ID, Buffer.concat([
          createEbmlUnsignedElement(EBML_TRACK_TYPE_ID, 2),
          createEbmlElement(EBML_AUDIO_ID, Buffer.concat([
            createEbmlFloatElement(EBML_SAMPLING_FREQUENCY_ID, staleFirstTracksMetadata.audioSampleRate),
            createEbmlUnsignedElement(EBML_CHANNELS_ID, staleFirstTracksMetadata.audioChannelCount),
          ])),
        ])),
      ]))
    : null
  const ebmlHeader = createEbmlElement(EBML_HEADER_ID, createEbmlElement(EBML_DOC_TYPE_ID, Buffer.from(docType, 'ascii')))
  const prefixedSegmentContent = prefixedSegmentBytes > 0
    ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(prefixedSegmentBytes))]
    : []
  const seekHeadSpecs = useSeekHead
    ? splitSeekHeads
      ? [{ includeInfo: true, includeTracks: false }, { includeInfo: false, includeTracks: true }]
      : staleFirstInfoSeekHead || staleFirstTracksSeekHead
        ? [
            {
              includeInfo: true,
              includeTracks: true,
              staleInfoTarget: staleFirstInfoSeekHead,
              staleTracksTarget: staleFirstTracksSeekHead,
            },
            {
              includeInfo: staleFirstInfoSeekHead,
              includeTracks: staleFirstTracksSeekHead,
            },
          ]
        : [{ includeInfo: true, includeTracks: true }]
    : []
  let seekHeads: Buffer[] = []
  if (useSeekHead) {
    seekHeads = seekHeadSpecs.map(() => createEbmlSeekHeadEntries([]))
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const seekHeadBytes = seekHeads.reduce((total, seekHead) => total + seekHead.length, 0)
      const prefixedSegmentContentBytes = prefixedSegmentContent.reduce((total, element) => total + element.length, 0)
      const staleInfoPosition = staleInfo ? seekHeadBytes + prefixedSegmentContentBytes : null
      const staleTracksPosition = staleTracks ? seekHeadBytes + prefixedSegmentContentBytes + (staleInfo?.length ?? 0) : null
      const infoPosition = seekHeadBytes
        + prefixedSegmentContentBytes
        + (staleInfo?.length ?? 0)
        + (staleTracks?.length ?? 0)
        + (interstitialSegmentBytes > 0 ? createEbmlElement(EBML_VOID_ID, Buffer.alloc(interstitialSegmentBytes)).length : 0)
      const tracksPosition = infoPosition + info.length
      const nextSeekHeads = seekHeadSpecs.map((spec) => createEbmlSeekHeadEntries([
        ...(spec.includeInfo ? [{
          targetId: EBML_INFO_ID,
          position: spec.staleInfoTarget ? (staleInfoPosition ?? 0) : infoPosition,
        }] : []),
        ...(spec.includeTracks ? [{
          targetId: EBML_TRACKS_ID,
          position: spec.staleTracksTarget ? (staleTracksPosition ?? 0) : tracksPosition,
        }] : []),
      ]))
      if (nextSeekHeads.length === seekHeads.length && nextSeekHeads.every((seekHead, index) => seekHead.equals(seekHeads[index] ?? Buffer.alloc(0)))) {
        break
      }
      seekHeads = nextSeekHeads
    }
  }
  const segment = createEbmlElement(EBML_SEGMENT_ID, Buffer.concat([
    ...seekHeads,
    ...prefixedSegmentContent,
    ...(staleInfo ? [staleInfo] : []),
    ...(staleTracks ? [staleTracks] : []),
    ...(interstitialSegmentBytes > 0 ? [createEbmlElement(EBML_VOID_ID, Buffer.alloc(interstitialSegmentBytes))] : []),
    info,
    tracks,
  ]))
  return Buffer.concat([ebmlHeader, segment])
}

const AVI_TEST_FRAME_RATE = 20

function createRiffChunk(chunkId: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(chunkId, 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const padding = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
  return Buffer.concat([header, payload, padding])
}

function createRiffList(listType: string, children: Buffer[]): Buffer {
  return createRiffChunk('LIST', Buffer.concat([Buffer.from(listType, 'ascii'), ...children]))
}

function createRiffForm(formType: string, children: Buffer[]): Buffer {
  const payload = Buffer.concat([Buffer.from(formType, 'ascii'), ...children])
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function createAviMainHeader(
  durationSeconds: number,
  width: number,
  height: number,
  options: { zeroDuration?: boolean | undefined; zeroDimensions?: boolean | undefined } = {},
): Buffer {
  const payload = Buffer.alloc(56)
  payload.writeUInt32LE(options.zeroDuration ? 0 : Math.round(1_000_000 / AVI_TEST_FRAME_RATE), 0)
  payload.writeUInt32LE(options.zeroDuration ? 0 : Math.round(durationSeconds * AVI_TEST_FRAME_RATE), 16)
  payload.writeUInt32LE(2, 24)
  payload.writeUInt32LE(options.zeroDimensions ? 0 : width, 32)
  payload.writeUInt32LE(options.zeroDimensions ? 0 : height, 36)
  return payload
}

function createAviStreamHeader(streamType: 'vids' | 'auds', durationSeconds: number): Buffer {
  const payload = Buffer.alloc(56)
  payload.write(streamType, 0, 'ascii')
  payload.writeUInt32LE(1, 20)
  if (streamType === 'vids') {
    payload.write('DIB ', 4, 'ascii')
    payload.writeUInt32LE(AVI_TEST_FRAME_RATE, 24)
    payload.writeUInt32LE(Math.round(durationSeconds * AVI_TEST_FRAME_RATE), 32)
    return payload
  }

  payload.writeUInt32LE(48_000, 24)
  payload.writeUInt32LE(Math.round(durationSeconds * 48_000), 32)
  return payload
}

function createAviBitmapInfoHeader(width: number, height: number): Buffer {
  const payload = Buffer.alloc(40)
  payload.writeUInt32LE(40, 0)
  payload.writeInt32LE(width, 4)
  payload.writeInt32LE(height, 8)
  payload.writeUInt16LE(1, 12)
  payload.writeUInt16LE(24, 14)
  return payload
}

function createAviWaveFormat(): Buffer {
  const payload = Buffer.alloc(16)
  payload.writeUInt16LE(1, 0)
  payload.writeUInt16LE(2, 2)
  payload.writeUInt32LE(48_000, 4)
  payload.writeUInt32LE(192_000, 8)
  payload.writeUInt16LE(4, 12)
  payload.writeUInt16LE(16, 14)
  return payload
}

function createTestAviBuffer(
  options: {
    durationSeconds?: number
    width?: number
    height?: number
    audioTrackFirst?: boolean
    zeroMainHeaderDuration?: boolean
    zeroMainHeaderDimensions?: boolean
    tailPaddingBytes?: number
  } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 3.5
  const width = options.width ?? 640
  const height = options.height ?? 360
  const audioTrackFirst = options.audioTrackFirst ?? true
  const tailPaddingBytes = options.tailPaddingBytes ?? 0
  const videoStreamList = createRiffList('strl', [
    createRiffChunk('strh', createAviStreamHeader('vids', durationSeconds)),
    createRiffChunk('strf', createAviBitmapInfoHeader(width, height)),
  ])
  const audioStreamList = createRiffList('strl', [
    createRiffChunk('strh', createAviStreamHeader('auds', durationSeconds)),
    createRiffChunk('strf', createAviWaveFormat()),
  ])
  const hdrl = createRiffList('hdrl', [
    createRiffChunk(
      'avih',
      createAviMainHeader(durationSeconds, width, height, {
        zeroDuration: options.zeroMainHeaderDuration,
        zeroDimensions: options.zeroMainHeaderDimensions,
      }),
    ),
    ...(audioTrackFirst ? [audioStreamList, videoStreamList] : [videoStreamList, audioStreamList]),
  ])
  return createRiffForm('AVI ', [
    hdrl,
    createRiffList('movi', []),
    ...(tailPaddingBytes > 0 ? [createRiffChunk('JUNK', Buffer.alloc(tailPaddingBytes))] : []),
  ])
}

const AAC_SAMPLE_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]

function aacSampleRateIndex(sampleRate: number): number {
  const index = AAC_SAMPLE_RATES.indexOf(sampleRate)
  if (index < 0) {
    throw new Error(`Unsupported AAC sample rate in test helper: ${sampleRate}`)
  }
  return index
}

function createAacAdtsFrame(sampleRate: number, channelCount: number, payloadLength: number = 8, rawBlocksPerFrame: number = 1): Buffer {
  if (rawBlocksPerFrame < 1 || rawBlocksPerFrame > 4) {
    throw new Error(`Unsupported raw block count in AAC test helper: ${rawBlocksPerFrame}`)
  }
  const frameLength = 7 + payloadLength
  const sampleRateIndex = aacSampleRateIndex(sampleRate)
  const frame = Buffer.alloc(frameLength, 0)
  frame[0] = 0xff
  frame[1] = 0xf1
  frame[2] = (1 << 6) | (sampleRateIndex << 2) | ((channelCount >> 2) & 0x1)
  frame[3] = ((channelCount & 0x3) << 6) | ((frameLength >> 11) & 0x3)
  frame[4] = (frameLength >> 3) & 0xff
  frame[5] = ((frameLength & 0x7) << 5) | 0x1f
  frame[6] = 0xfc | ((rawBlocksPerFrame - 1) & 0x03)
  return frame
}

function createTestAacBuffer(
  frameCount: number = 75,
  sampleRate: number = 48_000,
  channelCount: number = 2,
  payloadLength: number = 8,
  rawBlocksPerFrame: number = 1,
): Buffer {
  return Buffer.concat(Array.from({ length: frameCount }, () => createAacAdtsFrame(sampleRate, channelCount, payloadLength, rawBlocksPerFrame)))
}

function encodeSynchsafeInteger(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ])
}

function createId3v23TextFrame(frameId: string, value: string): Buffer {
  const text = Buffer.from(value, 'utf8')
  const payload = Buffer.concat([Buffer.from([3]), text])
  const frame = Buffer.alloc(10 + payload.length)
  frame.write(frameId, 0, 'ascii')
  frame.writeUInt32BE(payload.length, 4)
  payload.copy(frame, 10)
  return frame
}

function createTestMp3Id3Buffer(metadata: { title: string; artist: string; album: string }): Buffer {
  const frames = Buffer.concat([
    createId3v23TextFrame('TIT2', metadata.title),
    createId3v23TextFrame('TPE1', metadata.artist),
    createId3v23TextFrame('TALB', metadata.album),
  ])
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'ascii')
  header[3] = 3
  header[4] = 0
  encodeSynchsafeInteger(frames.length).copy(header, 6)
  return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
}

function createVorbisCommentBody(metadata: { title: string; artist: string; album: string }): Buffer {
  const vendor = Buffer.from('madar', 'utf8')
  const vendorLength = Buffer.alloc(4)
  vendorLength.writeUInt32LE(vendor.length, 0)
  const comments = [
    `TITLE=${metadata.title}`,
    `ARTIST=${metadata.artist}`,
    `ALBUM=${metadata.album}`,
  ].map((entry) => {
    const comment = Buffer.from(entry, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(comment.length, 0)
    return Buffer.concat([length, comment])
  })
  const commentCount = Buffer.alloc(4)
  commentCount.writeUInt32LE(comments.length, 0)
  return Buffer.concat([vendorLength, vendor, commentCount, ...comments])
}

function createFlacMetadataBlock(blockType: number, payload: Buffer, isLast: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (isLast ? 0x80 : 0) | (blockType & 0x7f)
  header.writeUIntBE(payload.length, 1, 3)
  return Buffer.concat([header, payload])
}

function createFlacStreamInfo(durationSeconds: number, sampleRate: number = 48_000, channelCount: number = 2, bitsPerSample: number = 16): Buffer {
  const streamInfo = Buffer.alloc(34)
  const totalSamples = BigInt(Math.round(durationSeconds * sampleRate))
  streamInfo.writeUInt16BE(4096, 0)
  streamInfo.writeUInt16BE(4096, 2)
  const packedHeader =
    (BigInt(sampleRate & 0x0f_ffff) << 44n) |
    (BigInt(channelCount - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    totalSamples
  streamInfo.writeBigUInt64BE(packedHeader, 10)
  return streamInfo
}

function createTestFlacBuffer(
  metadata: { title: string; artist: string; album: string },
  options: { durationSeconds?: number; sampleRate?: number; channelCount?: number } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 3.75
  const sampleRate = options.sampleRate ?? 48_000
  const channelCount = options.channelCount ?? 2
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    createFlacMetadataBlock(0, createFlacStreamInfo(durationSeconds, sampleRate, channelCount), false),
    createFlacMetadataBlock(4, createVorbisCommentBody(metadata), true),
    Buffer.from([0xff, 0xf8, 0x00, 0x00]),
  ])
}

function createOggPage(
  packet: Buffer,
  options: { headerType?: number; granulePosition?: bigint; bitstreamSerialNumber?: number; sequenceNumber?: number } = {},
): Buffer {
  if (packet.length >= 255) {
    throw new Error('Test helper only supports Ogg packets smaller than 255 bytes.')
  }

  const header = Buffer.alloc(28)
  header.write('OggS', 0, 'ascii')
  header[4] = 0
  header[5] = options.headerType ?? 0
  header.writeBigUInt64LE(options.granulePosition ?? 0n, 6)
  header.writeUInt32LE(options.bitstreamSerialNumber ?? 1, 14)
  header.writeUInt32LE(options.sequenceNumber ?? 0, 18)
  header.writeUInt32LE(0, 22)
  header[26] = 1
  header[27] = packet.length
  return Buffer.concat([header, packet])
}

function createOggSkeletonBosPage(bitstreamSerialNumber: number = 7): Buffer {
  return createOggPage(Buffer.from('fishead\0', 'binary'), {
    headerType: 0x02,
    granulePosition: 0n,
    bitstreamSerialNumber,
    sequenceNumber: 0,
  })
}

function createVorbisIdentificationPacket(sampleRate: number, channelCount: number): Buffer {
  const packet = Buffer.alloc(30)
  packet[0] = 1
  packet.write('vorbis', 1, 'ascii')
  packet.writeUInt32LE(0, 7)
  packet[11] = channelCount
  packet.writeUInt32LE(sampleRate, 12)
  packet.writeUInt32LE(0, 16)
  packet.writeUInt32LE(0, 20)
  packet.writeUInt32LE(0, 24)
  packet[28] = 0x11
  packet[29] = 1
  return packet
}

function createVorbisCommentPacket(metadata: { title: string; artist: string; album: string }): Buffer {
  return Buffer.concat([
    Buffer.from([3]),
    Buffer.from('vorbis', 'ascii'),
    createVorbisCommentBody(metadata),
    Buffer.from([1]),
  ])
}

function createTestOggVorbisBuffer(
  metadata: { title: string; artist: string; album: string },
  options: { durationSeconds?: number; sampleRate?: number; channelCount?: number } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 2.5
  const sampleRate = options.sampleRate ?? 44_100
  const channelCount = options.channelCount ?? 2
  const totalSamples = BigInt(Math.round(durationSeconds * sampleRate))
  const serial = 17
  return Buffer.concat([
    createOggPage(createVorbisIdentificationPacket(sampleRate, channelCount), {
      headerType: 0x02,
      granulePosition: 0n,
      bitstreamSerialNumber: serial,
      sequenceNumber: 0,
    }),
    createOggPage(createVorbisCommentPacket(metadata), {
      granulePosition: 0n,
      bitstreamSerialNumber: serial,
      sequenceNumber: 1,
    }),
    createOggPage(Buffer.from([0]), {
      headerType: 0x04,
      granulePosition: totalSamples,
      bitstreamSerialNumber: serial,
      sequenceNumber: 2,
    }),
  ])
}

function createOggFillerPages(totalBytes: number, bitstreamSerialNumber: number, startingSequenceNumber: number = 0): Buffer[] {
  const pages: Buffer[] = []
  let sequenceNumber = startingSequenceNumber
  let producedBytes = 0
  while (producedBytes < totalBytes) {
    const isLastPage = producedBytes + 282 >= totalBytes
    const page = createOggPage(Buffer.alloc(254, sequenceNumber % 251), {
      headerType: sequenceNumber === startingSequenceNumber ? 0x02 : isLastPage ? 0x04 : 0,
      granulePosition: 0n,
      bitstreamSerialNumber,
      sequenceNumber,
    })
    pages.push(page)
    producedBytes += page.length
    sequenceNumber += 1
  }
  return pages
}

function createOpusHeadPacket(channelCount: number, inputSampleRate: number = 48_000, preSkip: number = 312): Buffer {
  const packet = Buffer.alloc(19)
  packet.write('OpusHead', 0, 'ascii')
  packet[8] = 1
  packet[9] = channelCount
  packet.writeUInt16LE(preSkip, 10)
  packet.writeUInt32LE(inputSampleRate, 12)
  packet.writeInt16LE(0, 16)
  packet[18] = 0
  return packet
}

function createOpusTagsPacket(metadata: { title: string; artist: string; album: string }): Buffer {
  return Buffer.concat([Buffer.from('OpusTags', 'ascii'), createVorbisCommentBody(metadata)])
}

function createTestOggOpusBuffer(
  metadata: { title: string; artist: string; album: string },
  options: { durationSeconds?: number; channelCount?: number; inputSampleRate?: number; preSkip?: number } = {},
): Buffer {
  const durationSeconds = options.durationSeconds ?? 1.75
  const channelCount = options.channelCount ?? 1
  const inputSampleRate = options.inputSampleRate ?? 48_000
  const preSkip = options.preSkip ?? 312
  const serial = 23
  const terminalGranulePosition = BigInt(Math.round(durationSeconds * 48_000) + preSkip)
  return Buffer.concat([
    createOggPage(createOpusHeadPacket(channelCount, inputSampleRate, preSkip), {
      headerType: 0x02,
      granulePosition: 0n,
      bitstreamSerialNumber: serial,
      sequenceNumber: 0,
    }),
    createOggPage(createOpusTagsPacket(metadata), {
      granulePosition: 0n,
      bitstreamSerialNumber: serial,
      sequenceNumber: 1,
    }),
    createOggPage(Buffer.from([0]), {
      headerType: 0x04,
      granulePosition: terminalGranulePosition,
      bitstreamSerialNumber: serial,
      sequenceNumber: 2,
    }),
  ])
}

describe('generateGraph', () => {
  const generateGraphIntegrationTimeoutMs = 15_000

  test('persists local discovery safety paths and returns their structured summary', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'token.ts'), 'export function issueToken() { return "opaque" }\n', 'utf8')
      writeFileSync(join(tempDir, 'credentials.json'), '{"token":"do-not-read"}\n', 'utf8')

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        discovery_safety?: {
          summary: { total: number; sensitive: number; unreadable: number }
          exclusions: Array<{ path: string; kind: string; reason: string }>
        }
        nodes: Array<{ source_file?: string }>
      }

      expect(result.codeFiles).toBe(1)
      expect(result.discoverySafety?.summary).toMatchObject({ total: 1, sensitive: 1, unreadable: 0 })
      expect(result.discoveryExclusions).toContainEqual({
        path: 'credentials.json',
        kind: 'sensitive',
        reason: 'secret_config',
      })
      expect(graphData.discovery_safety).toEqual(result.discoverySafety)
      expect(graphData.nodes.some((node) => node.source_file?.endsWith('token.ts'))).toBe(true)
      expect(JSON.stringify(graphData.nodes)).not.toContain('credentials.json')
    })
  }, generateGraphIntegrationTimeoutMs)

  test('throws a stable unsupported-corpus error code when no supported files are detected', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'fixture.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]))

      try {
        generateGraph(tempDir, { noHtml: true })
        throw new Error('expected generateGraph() to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(GenerateUnsupportedCorpusError)
        expect((error as GenerateUnsupportedCorpusError).code).toBe('NO_SUPPORTED_FILES')
        expect((error as Error).message).toContain('No supported files were found in the target path.')
      }
    })
  })

  test('reports local safety paths when exclusions leave no supported corpus', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'credentials.json'), '{"token":"do-not-read"}\n', 'utf8')

      expect(() => generateGraph(tempDir, { noHtml: true })).toThrowError(
        expect.objectContaining({
          code: 'NO_SUPPORTED_FILES',
          message: expect.stringContaining('"credentials.json" (secret_config)'),
          discoverySafety: expect.objectContaining({
            summary: expect.objectContaining({ total: 1, sensitive: 1, unreadable: 0 }),
          }),
        }),
      )
    })
  })

  test('throws a stable unsupported-corpus error code when extraction yields zero graph nodes', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Notes only\\n', 'utf8')

      try {
        generateGraph(tempDir, { includeDocs: false, noHtml: true })
        throw new Error('expected generateGraph() to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(GenerateUnsupportedCorpusError)
        expect((error as GenerateUnsupportedCorpusError).code).toBe('NO_GRAPH_NODES')
        expect((error as Error).message).toContain('No graph nodes could be generated from the detected corpus.')
      }
    })
  })

  test('excludes Git-ignored files when respectGitignore is enabled', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, '.gitignore'), 'ignored.ts\n', 'utf8')
      writeFileSync(join(tempDir, 'tracked.ts'), 'export const tracked = true\n', 'utf8')
      writeFileSync(join(tempDir, 'untracked.ts'), 'export const untracked = true\n', 'utf8')
      writeFileSync(join(tempDir, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })
      execFileSync('git', ['add', '.gitignore', 'tracked.ts'], { cwd: tempDir, stdio: 'pipe' })

      generateGraph(tempDir, { noHtml: true, respectGitignore: true })

      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<{ source_file?: string }>
      }
      const sourceFiles = new Set(
        graphData.nodes.flatMap((node) => (typeof node.source_file === 'string' ? [normalizeAssertionPath(realpathSync(node.source_file))] : [])),
      )

      expect(sourceFiles).toContain(normalizeAssertionPath(realpathSync(join(tempDir, 'tracked.ts'))))
      expect(sourceFiles).toContain(normalizeAssertionPath(realpathSync(join(tempDir, 'untracked.ts'))))
      expect(sourceFiles).not.toContain(normalizeAssertionPath(realpathSync(join(tempDir, 'ignored.ts'))))
    })
  }, generateGraphIntegrationTimeoutMs)

  test('excludes Git-ignored files from a nested generation root', () => {
    withTempDir((repoRoot) => {
      const nestedRoot = join(repoRoot, 'workspace')
      mkdirSync(nestedRoot)
      writeFileSync(join(repoRoot, '.gitignore'), 'workspace/ignored.ts\n', 'utf8')
      writeFileSync(join(nestedRoot, 'tracked.ts'), 'export const tracked = true\n', 'utf8')
      writeFileSync(join(nestedRoot, 'untracked.ts'), 'export const untracked = true\n', 'utf8')
      writeFileSync(join(nestedRoot, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'pipe' })
      execFileSync('git', ['add', '.gitignore', 'workspace/tracked.ts'], { cwd: repoRoot, stdio: 'pipe' })

      generateGraph(nestedRoot, { noHtml: true, respectGitignore: true })

      const graphData = JSON.parse(readFileSync(join(nestedRoot, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<{ source_file?: string }>
      }
      const sourceFiles = new Set(
        graphData.nodes.flatMap((node) => (typeof node.source_file === 'string' ? [normalizeAssertionPath(realpathSync(node.source_file))] : [])),
      )

      expect(sourceFiles).toContain(normalizeAssertionPath(realpathSync(join(nestedRoot, 'tracked.ts'))))
      expect(sourceFiles).toContain(normalizeAssertionPath(realpathSync(join(nestedRoot, 'untracked.ts'))))
      expect(sourceFiles).not.toContain(normalizeAssertionPath(realpathSync(join(nestedRoot, 'ignored.ts'))))
    })
  }, generateGraphIntegrationTimeoutMs)

  test.runIf(process.platform !== 'win32')('excludes Git-ignored files through a symlinked generation root', () => {
    withTempDir((realRoot) => {
      withTempDir((aliasParent) => {
        writeFileSync(join(realRoot, '.gitignore'), 'ignored.ts\n', 'utf8')
        writeFileSync(join(realRoot, 'tracked.ts'), 'export const tracked = true\n', 'utf8')
        writeFileSync(join(realRoot, 'untracked.ts'), 'export const untracked = true\n', 'utf8')
        writeFileSync(join(realRoot, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
        execFileSync('git', ['init'], { cwd: realRoot, stdio: 'pipe' })
        execFileSync('git', ['add', '.gitignore', 'tracked.ts'], { cwd: realRoot, stdio: 'pipe' })

        const aliasedRoot = join(aliasParent, 'workspace')
        symlinkSync(realRoot, aliasedRoot, 'dir')
        generateGraph(aliasedRoot, { noHtml: true, respectGitignore: true })

        const graphData = JSON.parse(readFileSync(join(aliasedRoot, 'out', 'graph.json'), 'utf8')) as {
          nodes: Array<{ source_file?: string }>
        }
        const sourceFiles = new Set(graphData.nodes.map((node) => node.source_file))

        expect(sourceFiles).toContain(join(aliasedRoot, 'tracked.ts'))
        expect(sourceFiles).toContain(join(aliasedRoot, 'untracked.ts'))
        expect(sourceFiles).not.toContain(join(aliasedRoot, 'ignored.ts'))
      })
    })
  }, generateGraphIntegrationTimeoutMs)

  test('builds graph artifacts for a code corpus', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
        semantic_anomalies?: unknown
      }
      const manifestData = JSON.parse(readFileSync(join(tempDir, 'out', 'manifest.json'), 'utf8')) as {
        __madar_meta__?: { total_words?: number }
      }

      expect(result.mode).toBe('generate')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.edgeCount).toBeGreaterThan(0)
      expect(result.semanticAnomalyCount).toEqual(expect.any(Number))
      expect(existsSync(join(tempDir, 'out', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'GRAPH_REPORT.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.html'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'manifest.json'))).toBe(true)
      expect(manifestData.__madar_meta__?.total_words).toBe(result.totalWords)
      expect(readFileSync(join(tempDir, 'out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## God Nodes')
      expect(readFileSync(join(tempDir, 'out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## Semantic Anomalies')
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      for (const edge of graphData.links) {
        expect(edge).not.toHaveProperty('_src')
        expect(edge).not.toHaveProperty('_tgt')
        expect(edge).not.toHaveProperty('confidence_score')
      }
      expect(Array.isArray(graphData.semantic_anomalies)).toBe(true)
    })
  }, generateGraphIntegrationTimeoutMs)

  test('persists stored snippets for AST-backed TypeScript nodes in graph artifacts', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'auth.ts'),
        ['class AuthService {', '  login() {', '    return true', '  }', '}', '', 'export function logout() {', '  return false', '}'].join('\n'),
        'utf8',
      )

      generateGraph(tempDir, { noHtml: true })

      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const authService = graphData.nodes.find((node) => node.label === 'AuthService')
      const logout = graphData.nodes.find((node) => node.label === 'logout()')

      expect(authService?.source_location).toBe('L1-L5')
      expect(authService?.snippet).toContain('class AuthService {')
      expect(logout?.source_location).toBe('L7-L9')
      expect(logout?.snippet).toContain('export function logout() {')
    })
  }, generateGraphIntegrationTimeoutMs)

  test('builds graph artifacts with stitched relative workspace anonymous default-export barrel imports while keeping the worker isolated', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const result = generateGraph(workspaceRoot, { noHtml: true })
      const graphData = JSON.parse(readFileSync(join(workspaceRoot, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const apiFileId = graphData.nodes.find((node) => node.label === 'api.ts')?.id
      const sessionFileId = graphData.nodes.find((node) => node.label === 'session.ts')?.id
      const loginId = graphData.nodes.find((node) => node.label === '.login()')?.id
      const loginUserId = graphData.nodes.find((node) => node.label === 'loginUser()')?.id
      const reindexId = graphData.nodes.find((node) => node.label === 'reindexWorkspace()')?.id
      const createSessionId = graphData.nodes.find((node) => node.label === 'default()')?.id

      expect(result.codeFiles).toBe(5)
      expect(apiFileId).toBeTruthy()
      expect(sessionFileId).toBeTruthy()
      expect(loginId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(reindexId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === sessionFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === loginId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === reindexId && edge.target === createSessionId)).toBe(false)
    })
  })

  test('builds graph artifacts for rust module ownership and pub use imports with method calls', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod engine {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {',
          '      self.helper();',
          '    }',
          '    fn helper(&self) {}',
          '  }',
          '}',
          'pub use crate::engine::Worker;',
          'fn boot() {',
          '  Worker::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const moduleNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerNode = graphData.nodes.find((node) => node.label === 'Worker')

      expect(result.codeFiles).toBe(1)
      expect(moduleNode).toBeTruthy()
      expect(workerNode).toBeTruthy()
      expect(graphData.nodes.some((node) => node.label === '.run()')).toBe(true)
      expect(graphData.nodes.some((node) => node.label === '.helper()')).toBe(true)
      expect(graphData.nodes.some((node) => node.label === 'boot()')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === moduleNode?.id && edge.relation === 'contains')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === moduleNode?.id && edge.target === workerNode?.id && edge.relation === 'contains')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === workerNode?.id && edge.relation === 'imports_from')).toBe(true)
    })
  })

  test('builds graph artifacts for rust trait signatures and impl conformance edges inside a module', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod engine {',
          '  pub trait Runner {',
          '    fn run(&self);',
          '  }',
          '  pub struct Worker {}',
          '  impl Runner for Worker {',
          '    fn run(&self) {}',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const runnerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Runner')?.target
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runnerRunId = graphData.links.find((edge) => edge.source === runnerId && edge.relation === 'method' && graphData.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const workerRunId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method' && graphData.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target

      expect(result.codeFiles).toBe(1)
      expect(engineNode).toBeTruthy()
      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runnerRunId).toBeTruthy()
      expect(workerRunId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    })
  })

  test('builds graph artifacts for imported rust traits without duplicate trait owners', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod traits {',
          '  pub trait Runner {',
          '    fn run(&self);',
          '  }',
          '}',
          'use crate::traits::Runner;',
          'struct Worker {}',
          'impl Runner for Worker {',
          '  fn run(&self) {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const traitsNode = graphData.nodes.find((node) => node.label === 'traits')
      const runnerNodes = graphData.nodes.filter((node) => node.label === 'Runner')
      const runnerId = graphData.links.find((edge) => edge.source === traitsNode?.id && edge.relation === 'contains' && runnerNodes.some((node) => node.id === edge.target))?.target
      const workerNode = graphData.nodes.find((node) => node.label === 'Worker')

      expect(result.codeFiles).toBe(1)
      expect(runnerNodes).toHaveLength(1)
      expect(runnerId).toBeTruthy()
      expect(workerNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === workerNode?.id && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === runnerId && edge.relation === 'contains')).toBe(false)
    })
  })

  test('builds graph artifacts for rust super-path method calls inside nested modules', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod outer {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '  mod inner {',
          '    pub fn boot() {',
          '      super::Worker::run();',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const outerNode = graphData.nodes.find((node) => node.label === 'outer')
      const innerId = graphData.links.find((edge) => edge.source === outerNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const workerId = graphData.links.find((edge) => edge.source === outerNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method' && graphData.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = graphData.links.find((edge) => edge.source === innerId && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(result.codeFiles).toBe(1)
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('builds graph artifacts for cross-file rust trait imports without placeholder owners', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'traits.rs'), ['pub trait Runner {', '  fn run(&self);', '}'].join('\n'), 'utf8')
      writeFileSync(
        join(tempDir, 'worker.rs'),
        ['use crate::traits::Runner;', 'struct Worker {}', 'impl Runner for Worker {', '  fn run(&self) {}', '}'].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const workerFileId = graphData.nodes.find((node) => node.label === 'worker.rs')?.id
      const workerId = graphData.nodes.find((node) => node.label === 'Worker')?.id
      const runnerNodes = graphData.nodes.filter((node) => node.label === 'Runner')
      const runnerId = runnerNodes[0]?.id

      expect(result.codeFiles).toBe(2)
      expect(runnerNodes).toHaveLength(1)
      expect(workerFileId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runnerId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === workerFileId && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    })
  })

  test('builds graph artifacts for aliased rust grouped-use calls without duplicate owners', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod engine {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '}',
          'pub use crate::engine::{Worker as Client};',
          'fn boot() {',
          '  Client::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerNodes = graphData.nodes.filter((node) => node.label === 'Worker')
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method' && graphData.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = graphData.links.find((edge) => edge.source === fileNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(result.codeFiles).toBe(1)
      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
      expect(graphData.nodes.some((node) => node.label === 'Client')).toBe(false)
    })
  })

  test('builds graph artifacts with nested rust imports_from edges on the importing module', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod api {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '}',
          'mod client {',
          '  use crate::api::Worker;',
          '  pub fn boot() {',
          '    Worker::run();',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const apiNode = graphData.nodes.find((node) => node.label === 'api')
      const clientNode = graphData.nodes.find((node) => node.label === 'client')
      const workerId = graphData.links.find((edge) => edge.source === apiNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method' && graphData.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = graphData.links.find((edge) => edge.source === clientNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(result.codeFiles).toBe(1)
      expect(clientNode).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === clientNode?.id && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === workerId && edge.relation === 'imports_from')).toBe(false)
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('builds graph artifacts for aliased rust trait imports without duplicate trait owners', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod traits {',
          '  pub trait Runner {',
          '    fn run(&self);',
          '  }',
          '}',
          'use crate::traits::Runner as AliasTrait;',
          'struct Worker {}',
          'impl AliasTrait for Worker {',
          '  fn run(&self) {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const traitsNode = graphData.nodes.find((node) => node.label === 'traits')
      const runnerNodes = graphData.nodes.filter((node) => node.label === 'Runner')
      const runnerId = graphData.links.find((edge) => edge.source === traitsNode?.id && edge.relation === 'contains' && runnerNodes.some((node) => node.id === edge.target))?.target
      const workerNode = graphData.nodes.find((node) => node.label === 'Worker')

      expect(result.codeFiles).toBe(1)
      expect(runnerNodes).toHaveLength(1)
      expect(runnerId).toBeTruthy()
      expect(workerNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === workerNode?.id && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
      expect(graphData.nodes.some((node) => node.label === 'AliasTrait')).toBe(false)
    })
  })

  test('builds graph artifacts for rust anchor-only super-path free-function calls inside nested modules', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'fn run() {}',
          'mod outer {',
          '  pub fn run() {}',
          '  mod inner {',
          '    pub fn boot() {',
          '      super::run();',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileId = graphData.nodes.find((node) => node.label === 'worker.rs')?.id
      const topLevelRunId = graphData.links.find((edge) => edge.source === fileId && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const outerId = graphData.nodes.find((node) => node.label === 'outer')?.id
      const innerId = graphData.links.find((edge) => edge.source === outerId && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const outerRunId = graphData.links.find((edge) => edge.source === outerId && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const bootId = graphData.links.find((edge) => edge.source === innerId && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(result.codeFiles).toBe(1)
      expect(topLevelRunId).toBeTruthy()
      expect(outerRunId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === outerRunId && edge.relation === 'calls')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === topLevelRunId && edge.relation === 'calls')).toBe(false)
    })
  })

  test('builds graph artifacts without false calls from missing rust anchor-only super paths', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'fn run() {}',
          'mod outer {',
          '  mod inner {',
          '    pub fn boot() {',
          '      super::run();',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const bootNode = graphData.nodes.find((node) => node.label === 'boot()')
      const runNode = graphData.nodes.find((node) => node.label === 'run()')

      expect(result.codeFiles).toBe(1)
      expect(bootNode).toBeTruthy()
      expect(runNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === bootNode?.id && edge.target === runNode?.id && edge.relation === 'calls')).toBe(false)
    })
  })

  test('builds graph artifacts without self-inherits edges for inherent rust impl blocks', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod engine {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    fn run(&self) {}',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target

      expect(result.codeFiles).toBe(1)
      expect(workerId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === workerId && edge.target === workerId && edge.relation === 'inherits')).toBe(false)
    })
  })

  test('builds graph artifacts for nested rust modules without merging same-named types', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod alpha {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '}',
          'mod beta {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '}',
          'fn boot_alpha() {',
          '  alpha::Worker::run();',
          '}',
          'fn boot_beta() {',
          '  beta::Worker::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const alphaNode = graphData.nodes.find((node) => node.label === 'alpha')
      const betaNode = graphData.nodes.find((node) => node.label === 'beta')
      const workerNodes = graphData.nodes.filter((node) => node.label === 'Worker')
      const alphaWorkerId = graphData.links.find((edge) => edge.source === alphaNode?.id && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const betaWorkerId = graphData.links.find((edge) => edge.source === betaNode?.id && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const alphaRunId = graphData.links.find((edge) => edge.source === alphaWorkerId && edge.relation === 'method')?.target
      const betaRunId = graphData.links.find((edge) => edge.source === betaWorkerId && edge.relation === 'method')?.target
      const bootAlphaNode = graphData.nodes.find((node) => node.label === 'boot_alpha()')
      const bootBetaNode = graphData.nodes.find((node) => node.label === 'boot_beta()')

      expect(result.codeFiles).toBe(1)
      expect(workerNodes).toHaveLength(2)
      expect(alphaWorkerId).toBeTruthy()
      expect(betaWorkerId).toBeTruthy()
      expect(alphaWorkerId).not.toBe(betaWorkerId)
      expect(alphaRunId).toBeTruthy()
      expect(betaRunId).toBeTruthy()
      expect(alphaRunId).not.toBe(betaRunId)
      expect(graphData.links.some((edge) => edge.source === bootAlphaNode?.id && edge.target === alphaRunId && edge.relation === 'calls')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === bootBetaNode?.id && edge.target === betaRunId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('builds graph artifacts for rust imports when use declarations appear before the local module owner', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'use crate::engine::Worker;',
          'mod engine {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '}',
          'fn boot() {',
          '  Worker::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains')?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method')?.target
      const bootNode = graphData.nodes.find((node) => node.label === 'boot()')

      expect(result.codeFiles).toBe(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(graphData.links.some((edge) => edge.source === bootNode?.id && edge.target === runId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('builds graph artifacts for qualified rust impl owners on the existing namespaced type', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod engine {',
          '  pub struct Worker {}',
          '}',
          'impl crate::engine::Worker {',
          '  fn run(&self) {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerNodes = graphData.nodes.filter((node) => node.label === 'Worker')
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method')?.target

      expect(result.codeFiles).toBe(1)
      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
    })
  })

  test('builds graph artifacts for qualified rust impl owners before the namespaced type declaration without duplicate owners', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'impl crate::engine::Worker {',
          '  fn run(&self) {}',
          '}',
          'mod engine {',
          '  pub struct Worker {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const fileNode = graphData.nodes.find((node) => node.label === 'worker.rs')
      const engineNode = graphData.nodes.find((node) => node.label === 'engine')
      const workerNodes = graphData.nodes.filter((node) => node.label === 'Worker')
      const workerId = graphData.links.find((edge) => edge.source === engineNode?.id && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method')?.target

      expect(result.codeFiles).toBe(1)
      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === fileNode?.id && edge.target === workerId && edge.relation === 'contains')).toBe(false)
    })
  })

  test('builds graph artifacts for rust local namespaced type calls inside the current module', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod alpha {',
          '  pub struct Worker {}',
          '  impl Worker {',
          '    pub fn run(&self) {}',
          '  }',
          '  fn boot() {',
          '    Worker::run();',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const alphaNode = graphData.nodes.find((node) => node.label === 'alpha')
      const workerId = graphData.links.find((edge) => edge.source === alphaNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = graphData.links.find((edge) => edge.source === workerId && edge.relation === 'method')?.target
      const bootId = graphData.links.find((edge) => edge.source === alphaNode?.id && edge.relation === 'contains' && graphData.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(result.codeFiles).toBe(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('builds graph artifacts without false calls from qualified rust module paths onto unrelated free functions', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'worker.rs'),
        [
          'mod api {',
          '  pub fn helper() {}',
          '}',
          'fn run() {}',
          'fn boot() {',
          '  api::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const bootNode = graphData.nodes.find((node) => node.label === 'boot()')
      const runNode = graphData.nodes.find((node) => node.label === 'run()')

      expect(result.codeFiles).toBe(1)
      expect(bootNode).toBeTruthy()
      expect(runNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === bootNode?.id && edge.target === runNode?.id && edge.relation === 'calls')).toBe(false)
    })
  })

  test('builds graph artifacts for a docs-and-images corpus without code', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Overview\n![Diagram](diagram.svg)\nSee [Guide](guide.md)\n## Details\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')
      writeFileSync(join(tempDir, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.codeFiles).toBe(0)
      expect(result.nonCodeFiles).toBeGreaterThan(0)
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(graphData.nodes.some((node) => node.file_type === 'image')).toBe(true)
    })
  })

  test('builds graph artifacts for a docs-and-local-media corpus without code', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Episode](episode.mp3)\nSee [Demo](demo.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'episode.mp3'), Buffer.from('ID3'))
      writeFileSync(join(tempDir, 'demo.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.codeFiles).toBe(0)
      expect(result.nonCodeFiles).toBe(3)
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode.mp3',
            content_type: 'audio/mpeg',
            file_bytes: 3,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'demo.mp4',
            content_type: 'video/mp4',
            file_bytes: 8,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic duration metadata for supported local media formats', () => {
    withTempDir((tempDir) => {
      const wavBuffer = createTestWavBuffer(1.5)
      const mp4Buffer = createTestMp4Buffer(2.5)
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Tone](tone.wav)\nSee [Clip](clip.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'tone.wav'), wavBuffer)
      writeFileSync(join(tempDir, 'clip.mp4'), mp4Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(3)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'tone.wav',
            media_duration_seconds: 1.5,
            audio_sample_rate_hz: 4000,
            audio_channel_count: 2,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'clip.mp4',
            media_duration_seconds: 2.5,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic MP3 track metadata from saved assets', () => {
    withTempDir((tempDir) => {
      const mp3Buffer = createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Madar FM',
        album: 'Engineering Notes',
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Episode](episode.mp3)\n', 'utf8')
      writeFileSync(join(tempDir, 'episode.mp3'), mp3Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode.mp3',
            audio_title: 'Roadmap Review',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic FLAC and Ogg-family metadata from saved assets', () => {
    withTempDir((tempDir) => {
      const flacBuffer = createTestFlacBuffer({
        title: 'Roadmap Review',
        artist: 'Madar FM',
        album: 'Engineering Notes',
      })
      const oggBuffer = createTestOggVorbisBuffer({
        title: 'Release Notes',
        artist: 'Madar FM',
        album: 'Engineering Notes',
      })
      const opusBuffer = createTestOggOpusBuffer({
        title: 'Voice Memo',
        artist: 'Madar FM',
        album: 'Engineering Notes',
      })
      writeFileSync(
        join(tempDir, 'README.md'),
        '# Overview\nSee [Lossless](lossless.flac)\nSee [Ogg](release.ogg)\nSee [Opus](voice.opus)\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'lossless.flac'), flacBuffer)
      writeFileSync(join(tempDir, 'release.ogg'), oggBuffer)
      writeFileSync(join(tempDir, 'voice.opus'), opusBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(4)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'lossless.flac',
            media_duration_seconds: 3.75,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            audio_title: 'Roadmap Review',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
          expect.objectContaining({
            file_type: 'audio',
            label: 'release.ogg',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 44100,
            audio_channel_count: 2,
            audio_title: 'Release Notes',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
          expect.objectContaining({
            file_type: 'audio',
            label: 'voice.opus',
            media_duration_seconds: 1.75,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 1,
            audio_title: 'Voice Memo',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Ogg-family metadata when a non-audio BOS stream appears first', () => {
    withTempDir((tempDir) => {
      const oggBuffer = Buffer.concat([
        createOggSkeletonBosPage(),
        createTestOggVorbisBuffer({
          title: 'Release Notes',
          artist: 'Madar FM',
          album: 'Engineering Notes',
        }),
      ])
      const opusBuffer = Buffer.concat([
        createOggSkeletonBosPage(),
        createTestOggOpusBuffer({
          title: 'Voice Memo',
          artist: 'Madar FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(
        join(tempDir, 'README.md'),
        '# Overview\nSee [Ogg](prefixed-vorbis.ogg)\nSee [Opus](prefixed-opus.opus)\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'prefixed-vorbis.ogg'), oggBuffer)
      writeFileSync(join(tempDir, 'prefixed-opus.opus'), opusBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(3)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'prefixed-vorbis.ogg',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 44100,
            audio_channel_count: 2,
            audio_title: 'Release Notes',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
          expect.objectContaining({
            file_type: 'audio',
            label: 'prefixed-opus.opus',
            media_duration_seconds: 1.75,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 1,
            audio_title: 'Voice Memo',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Ogg-family metadata when a large prefixed non-audio stream pushes the audio BOS pages beyond the default head window', () => {
    withTempDir((tempDir) => {
      const oggBuffer = Buffer.concat([
        ...createOggFillerPages(300_000, 29),
        createTestOggVorbisBuffer({
          title: 'Release Notes',
          artist: 'Madar FM',
          album: 'Engineering Notes',
        }),
      ])
      const opusBuffer = Buffer.concat([
        ...createOggFillerPages(300_000, 31),
        createTestOggOpusBuffer({
          title: 'Voice Memo',
          artist: 'Madar FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(
        join(tempDir, 'README.md'),
        '# Overview\nSee [Ogg](large-prefixed-vorbis.ogg)\nSee [Opus](large-prefixed-opus.opus)\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'large-prefixed-vorbis.ogg'), oggBuffer)
      writeFileSync(join(tempDir, 'large-prefixed-opus.opus'), opusBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(3)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'large-prefixed-vorbis.ogg',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 44100,
            audio_channel_count: 2,
            audio_title: 'Release Notes',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
          expect.objectContaining({
            file_type: 'audio',
            label: 'large-prefixed-opus.opus',
            media_duration_seconds: 1.75,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 1,
            audio_title: 'Voice Memo',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic AAC and M4A metadata from saved assets', () => {
    withTempDir((tempDir) => {
      const aacBuffer = createTestAacBuffer()
      const m4aBuffer = createTestM4aBuffer({
        title: 'Roadmap Review',
        artist: 'Madar FM',
        album: 'Engineering Notes',
      })
      writeFileSync(
        join(tempDir, 'README.md'),
        '# Overview\nSee [Tone](tone.aac)\nSee [Episode](episode.m4a)\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'tone.aac'), aacBuffer)
      writeFileSync(join(tempDir, 'episode.m4a'), m4aBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(3)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'tone.aac',
            media_duration_seconds: 1.6,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
          }),
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode.m4a',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            audio_title: 'Roadmap Review',
            audio_artist: 'Madar FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with AAC duration based on the ADTS raw block count', () => {
    withTempDir((tempDir) => {
      const aacBuffer = createTestAacBuffer(20, 48_000, 2, 8, 3)
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Tone](multiblock.aac)\n', 'utf8')
      writeFileSync(join(tempDir, 'multiblock.aac'), aacBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'multiblock.aac',
            media_duration_seconds: 1.28,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic direct-video container metadata from saved assets, including large AVI files', () => {
    withTempDir((tempDir) => {
      const mp4Buffer = createTestVideoMp4Buffer()
      const aviBuffer = createTestAviBuffer({
        zeroMainHeaderDuration: true,
        zeroMainHeaderDimensions: true,
        tailPaddingBytes: 300_000,
      })
      const webmBuffer = createTestMatroskaBuffer()
      const mkvBuffer = createTestMatroskaBuffer({ docType: 'matroska', durationSeconds: 6.75, width: 854, height: 480 })
      writeFileSync(
        join(tempDir, 'README.md'),
        '# Overview\nSee [Clip](clip.mp4)\nSee [Recording](recording.avi)\nSee [Session](session.webm)\nSee [Archive](archive.mkv)\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'clip.mp4'), mp4Buffer)
      writeFileSync(join(tempDir, 'recording.avi'), aviBuffer)
      writeFileSync(join(tempDir, 'session.webm'), webmBuffer)
      writeFileSync(join(tempDir, 'archive.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(5)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'clip.mp4',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1920,
            video_height_px: 1080,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'recording.avi',
            media_duration_seconds: 3.5,
            video_width_px: 640,
            video_height_px: 360,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'session.webm',
            media_duration_seconds: 4.25,
            video_width_px: 1280,
            video_height_px: 720,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'archive.mkv',
            media_duration_seconds: 6.75,
            video_width_px: 854,
            video_height_px: 480,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with embedded audio-track metadata for MP4-family video assets when the video track appears first', () => {
    withTempDir((tempDir) => {
      const movBuffer = createTestVideoMp4Buffer({ audioTrackFirst: false })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Clip](clip.mov)\n', 'utf8')
      writeFileSync(join(tempDir, 'clip.mov'), movBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'clip.mov',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1920,
            video_height_px: 1080,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with embedded audio-track metadata for AVI video assets when the video stream appears first', () => {
    withTempDir((tempDir) => {
      const aviBuffer = createTestAviBuffer({ audioTrackFirst: false })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Clip](clip.avi)\n', 'utf8')
      writeFileSync(join(tempDir, 'clip.avi'), aviBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'clip.avi',
            media_duration_seconds: 3.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 640,
            video_height_px: 360,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with embedded audio-track metadata for Matroska/WebM video assets when the video track appears first', () => {
    withTempDir((tempDir) => {
      const webmBuffer = createTestMatroskaBuffer({ audioTrackFirst: false, includeAudioTrackMetadata: true })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Session](session.webm)\n', 'utf8')
      writeFileSync(join(tempDir, 'session.webm'), webmBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'session.webm',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata when a large prefixed segment element pushes Info and Tracks beyond the default head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 300_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](archive.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'archive.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'archive.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata via SeekHead when Info and Tracks sit beyond the widened head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-windowed.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-windowed.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'seekhead-windowed.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata when later top-level Info and Tracks sit beyond the widened head window without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-windowed.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-windowed.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'top-level-windowed.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata when a later top-level Tracks element is video-only without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        interstitialSegmentBytes: 600_000,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-clear-audio.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata when a later top-level Tracks element is audio-only without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-clear-video.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-clear-video.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-clear-video.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-clear-video.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts with preserved Matroska/WebM track metadata when a later authoritative Tracks element is unreadable', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        useSeekHead: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-tracks-unreadable.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-tracks-unreadable.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const mkvNode = (JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }).nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-unreadable.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        file_type: 'video',
        label: 'seekhead-tracks-unreadable.mkv',
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts with preserved Matroska/WebM track metadata when a later top-level Tracks element is unreadable without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-unreadable.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-unreadable.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-unreadable.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-unreadable.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata when a later top-level Tracks element is video-only and bounded by a trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        interstitialSegmentBytes: 600_000,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-trailing-child-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-trailing-child-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-trailing-child-clear-audio.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata when a later top-level Tracks element is audio-only and bounded by a trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-trailing-child-clear-video.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-trailing-child-clear-video.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-clear-video.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-trailing-child-clear-video.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM track metadata when a later top-level Tracks element is bounded by a trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-trailing-child-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-trailing-child-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-corrective.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-trailing-child-corrective.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM track metadata when a later top-level Tracks element is followed by an overrun trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        malformedTrailingTracksChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-trailing-child-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-trailing-child-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-trailing-child-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM track metadata when a later top-level Tracks element is followed by a truncated trailing child header without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        truncatedTrailingTracksChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-tracks-trailing-child-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-tracks-trailing-child-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-tracks-trailing-child-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration metadata when a later top-level Info element omits duration without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-clear-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-clear-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-clear-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-clear-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration metadata when a later top-level Info element omits duration before a trailing child at the exact Info boundary without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-clear-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-clear-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-clear-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-clear-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration before a trailing child at the exact Info boundary without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-invalid-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-invalid-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-invalid-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration followed by an overrun trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        malformedTrailingInfoChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-invalid-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-invalid-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-invalid-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration metadata when a later top-level Info element omits duration and is followed by an overrun trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        malformedTrailingInfoChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-omitted-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-omitted-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-omitted-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-omitted-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration metadata when a later top-level Info element omits duration and is followed by a truncated trailing child header without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-omitted-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-omitted-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-omitted-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-omitted-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration followed by a truncated trailing child header without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-invalid-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-invalid-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-invalid-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM duration when a later top-level Info element is bounded by a trailing child without SeekHead help', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        interstitialSegmentBytes: 600_000,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        trailingInfoChildBytes: 65_536,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](top-level-info-trailing-child-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'top-level-info-trailing-child-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-corrective.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'top-level-info-trailing-child-corrective.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
    })
  })

  test('builds graph artifacts with Matroska/WebM track metadata via SeekHead when the Tracks element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedTracksBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-tracks-partial.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-tracks-partial.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'seekhead-tracks-partial.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM duration without SeekHead when the direct Info element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        prefixedInfoBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-partial.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-partial.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-partial.mkv',
            media_duration_seconds: 4.25,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-padding.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-padding.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-trailing-padding.mkv',
            media_duration_seconds: 4.25,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM duration without SeekHead when a direct Info target with parseable duration is followed by a trailing child at the exact Info boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-trailing-child.mkv',
            media_duration_seconds: 4.25,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration without SeekHead when a later direct Info target is unreadable on bounded reread', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        prefixedInfoBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-unreadable-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-unreadable-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-unreadable-stale.mkv',
            media_duration_seconds: 1.5,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM track metadata without SeekHead when the direct Tracks element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedTracksBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-partial.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-partial.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-partial.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        trailingTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-padding.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-padding.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-trailing-padding.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        trailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-trailing-child.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM duration metadata without SeekHead when the later direct Info element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        prefixedInfoBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-padding-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-padding-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-trailing-padding-corrective.mkv',
            media_duration_seconds: 4.25,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM duration from a direct Info target without SeekHead when corrected duration is followed by a trailing child at the exact Info boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-info-trailing-child-corrective.mkv',
            media_duration_seconds: 4.25,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-padding-clear-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-padding-clear-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-clear-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-padding-clear-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is omitted before trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-padding-omit-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-padding-omit-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-omit-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-padding-omit-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is omitted before a trailing metadata child beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-omit-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-omit-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-omit-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-omit-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is malformed before a trailing metadata child beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-invalid-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-invalid-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-invalid-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration from a direct Info prefix without SeekHead when malformed Duration is followed by an overrun trailing metadata child', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-invalid-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-invalid-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-invalid-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration from a direct Info prefix without SeekHead when malformed Duration is followed by a truncated trailing metadata child header', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-invalid-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-invalid-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-invalid-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration from a direct Info prefix without SeekHead when an omitted-Duration trailing metadata child overruns the Info boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM duration from a direct Info prefix without SeekHead when an omitted-Duration trailing metadata child header is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-trailing-child-omitted-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-trailing-child-omitted-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-omitted-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-trailing-child-omitted-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
      })
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM track metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-padding-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-padding-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-trailing-padding-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with corrected Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-trailing-child-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM track metadata without SeekHead when a later direct Tracks target is unreadable on bounded reread', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-unreadable-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-unreadable-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'direct-tracks-unreadable-stale.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 8_000,
            audio_channel_count: 1,
            video_width_px: 5,
            video_height_px: 2,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-padding-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-padding-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-padding-clear-audio.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-child-clear-audio.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-padding-clear-dimensions.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-padding-clear-dimensions.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-clear-dimensions.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-padding-clear-dimensions.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        trailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child-clear-dimensions.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child-clear-dimensions.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-clear-dimensions.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-child-clear-dimensions.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration metadata without SeekHead when the later direct Info element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        prefixedInfoBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-info-clear-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-info-clear-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-clear-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-info-clear-duration.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-clear-audio.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        prefixedTracksBytes: 600_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-clear-dimensions.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-clear-dimensions.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-clear-dimensions.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-clear-dimensions.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM track metadata without SeekHead when a later direct Tracks prefix is followed by a truncated trailing child header', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        truncatedTrailingTracksChildHeader: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child-truncated-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child-truncated-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-truncated-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-child-truncated-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts with preserved stale Matroska/WebM track metadata without SeekHead when a later direct Tracks prefix is followed by an overrun trailing child', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
        malformedTrailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](direct-tracks-trailing-child-overrun-stale.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'direct-tracks-trailing-child-overrun-stale.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }
      const mkvNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-overrun-stale.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        label: 'direct-tracks-trailing-child-overrun-stale.mkv',
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
      })
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata when separate SeekHeads advertise Info and Tracks beyond the widened head window', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
        splitSeekHeads: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-split.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-split.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'seekhead-split.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata when a later SeekHead overrides stale direct Tracks metadata', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        useSeekHead: true,
        staleFirstTracksSeekHead: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'seekhead-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with Matroska/WebM metadata when a later SeekHead overrides stale direct Info metadata', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        useSeekHead: true,
        staleFirstInfoSeekHead: true,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-info-corrective.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-info-corrective.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'seekhead-info-corrective.mkv',
            media_duration_seconds: 4.25,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts without stale Matroska/WebM audio-track metadata when a later authoritative Tracks element is video-only', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: false,
        useSeekHead: true,
        staleFirstTracksSeekHead: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-tracks-clear-audio.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-tracks-clear-audio.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const mkvNode = (JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }).nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-clear-audio.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        file_type: 'video',
        label: 'seekhead-tracks-clear-audio.mkv',
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM video-dimension metadata when a later authoritative Tracks element is audio-only', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        useSeekHead: true,
        staleFirstTracksSeekHead: true,
        finalTracksAudioOnly: true,
        staleFirstTracksMetadata: {
          width: 5,
          height: 2,
          audioSampleRate: 8_000,
          audioChannelCount: 1,
        },
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-tracks-clear-video.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-tracks-clear-video.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const mkvNode = (JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }).nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-clear-video.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        file_type: 'video',
        label: 'seekhead-tracks-clear-video.mkv',
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    })
  })

  test('builds graph artifacts without stale Matroska/WebM duration metadata when a later authoritative Info element omits duration', () => {
    withTempDir((tempDir) => {
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        useSeekHead: true,
        staleFirstInfoSeekHead: true,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Archive](seekhead-info-clear-duration.mkv)\n', 'utf8')
      writeFileSync(join(tempDir, 'seekhead-info-clear-duration.mkv'), mkvBuffer)

      const result = generateGraph(tempDir)
      const mkvNode = (JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }).nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-info-clear-duration.mkv')

      expect(result.nonCodeFiles).toBe(2)
      expect(mkvNode).toMatchObject({
        file_type: 'video',
        label: 'seekhead-info-clear-duration.mkv',
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    })
  })

  test('builds graph artifacts with tkhd dimension fallback for MP4-family video assets when the visual sample entry is truncated', () => {
    withTempDir((tempDir) => {
      const mp4Buffer = createTestVideoMp4Buffer({ truncateVideoSampleEntry: true, includeVideoTkhdDimensions: true })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Clip](tkhd-fallback.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'tkhd-fallback.mp4'), mp4Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'tkhd-fallback.mp4',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1920,
            video_height_px: 1080,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with mdhd duration fallback for MP4-family video assets when mvhd is absent', () => {
    withTempDir((tempDir) => {
      const mp4Buffer = createTestVideoMp4Buffer({ omitMovieHeaderDuration: true, includeTrackMdhdDuration: true })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Clip](mdhd-fallback.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'mdhd-fallback.mp4'), mp4Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'mdhd-fallback.mp4',
            media_duration_seconds: 2.5,
            audio_sample_rate_hz: 48000,
            audio_channel_count: 2,
            video_width_px: 1920,
            video_height_px: 1080,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts without Matroska/WebM duration when TimecodeScale is zero', () => {
    withTempDir((tempDir) => {
      const webmBuffer = createTestMatroskaBuffer({ timecodeScale: 0 })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Session](zero-scale.webm)\n', 'utf8')
      writeFileSync(join(tempDir, 'zero-scale.webm'), webmBuffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'video',
            label: 'zero-scale.webm',
            video_width_px: 1280,
            video_height_px: 720,
          }),
        ]),
      )
      const videoNode = graphData.nodes.find((node) => node.file_type === 'video' && node.label === 'zero-scale.webm')
      expect(videoNode?.media_duration_seconds).toBeUndefined()
    })
  })

  test('does not re-index saved memory notes from out/memory by default', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'auth.ts'), 'export function authenticate() {\n  return true\n}\n', 'utf8')
      mkdirSync(join(tempDir, 'out', 'memory'), { recursive: true })
      writeFileSync(
        join(tempDir, 'out', 'memory', 'query_auth.md'),
        [
          '---',
          'title: "Auth result"',
          'source_url: "https://example.com/auth"',
          'captured_at: "2026-04-11T00:00:00Z"',
          'source_nodes: ["authenticate()"]',
          '---',
          '',
          '# Q: How does auth work?',
          '',
          '## Answer',
          '',
          'Authentication starts in authenticate().',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
      }
      const noteNode = graphData.nodes.find((node) => node.label === 'query_auth.md')

      expect(noteNode).toBeUndefined()
      expect(graphData.links.some((edge) => edge.relation === 'references')).toBe(false)
    })
  })

  test('supports cluster-only regeneration from an existing graph', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      const result = generateGraph(tempDir, { clusterOnly: true })

      expect(result.mode).toBe('cluster-only')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(readFileSync(join(tempDir, 'out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## Communities')
    })
  })

  test('tracks incremental update changes after a manifest exists', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      writeFileSync(sourcePath, 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return 2\n\ndef other():\n    return greet()\n', 'utf8')

      const result = generateGraph(tempDir, { update: true })

      expect(result.mode).toBe('update')
      expect(result.changedFiles).toBeGreaterThan(0)
      expect(result.deletedFiles).toBe(0)
      expect(existsSync(join(tempDir, 'out', 'manifest.json'))).toBe(true)
    })
  })

  test('rebuilds incremental updates from full extraction when the existing graph predates anonymous default-export targets', async () => {
    await withTempDirAsync(async (tempDir) => {
      const backendDir = join(tempDir, 'backend')
      const sharedDir = join(tempDir, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      writeFileSync(
        join(backendDir, 'api.ts'),
        [
          "import createSession from '../shared/auth.js'",
          '',
          'export function loginUser() {',
          '  return createSession()',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(sharedDir, 'auth.ts'),
        [
          'export default function () {',
          "  return 'session'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const initial = generateGraph(tempDir, { noHtml: true })
      const staleGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        extractor_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
      }

      staleGraphData.extractor_version = 59
      staleGraphData.nodes = staleGraphData.nodes.filter((node) => node.label !== 'default()')
      staleGraphData.links = staleGraphData.links.filter((edge) => edge.target !== 'auth_default')
      writeFileSync(initial.graphPath, `${JSON.stringify(staleGraphData, null, 2)}\n`, 'utf8')

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        extractor_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const apiFileId = updatedGraphData.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = updatedGraphData.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = updatedGraphData.nodes.find((node) => node.label === 'default()' && String(node.source_file).endsWith('/shared/auth.ts'))?.id

      expect(updated.changedFiles).toBe(0)
      expect(updated.notes.join('\n')).toContain('Existing graph uses extractor version 59, so --update rebuilt the full graph.')
      expect(updatedGraphData.extractor_version).not.toBe(59)
      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(updatedGraphData.links.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(updatedGraphData.links.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('rebuilds incremental updates from full extraction when the existing graph lacks extractor version metadata', async () => {
    await withTempDirAsync(async (tempDir) => {
      const backendDir = join(tempDir, 'backend')
      const sharedDir = join(tempDir, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      writeFileSync(
        join(backendDir, 'api.ts'),
        [
          "import createSession from '../shared/auth.js'",
          '',
          'export function loginUser() {',
          '  return createSession()',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(sharedDir, 'auth.ts'),
        [
          'export default function () {',
          "  return 'session'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const initial = generateGraph(tempDir, { noHtml: true })
      const staleGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        extractor_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
      }

      delete staleGraphData.extractor_version
      staleGraphData.nodes = staleGraphData.nodes.filter((node) => node.label !== 'default()')
      staleGraphData.links = staleGraphData.links.filter((edge) => edge.target !== 'auth_default')
      writeFileSync(initial.graphPath, `${JSON.stringify(staleGraphData, null, 2)}\n`, 'utf8')

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        extractor_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<{ source: string; target: string; relation: string }>
      }
      const apiFileId = updatedGraphData.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = updatedGraphData.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = updatedGraphData.nodes.find((node) => node.label === 'default()' && String(node.source_file).endsWith('/shared/auth.ts'))?.id

      expect(updated.changedFiles).toBe(0)
      expect(updated.notes.join('\n')).toContain('Existing graph predates extractor version metadata, so --update rebuilt the full graph.')
      expect(typeof updatedGraphData.extractor_version).toBe('number')
      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(updatedGraphData.links.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(updatedGraphData.links.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
    })
  })

  test('treats local media sidecar-only changes as incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const audioPath = join(tempDir, 'episode.mp3')
      const sidecarPath = binaryIngestSidecarPath(audioPath)
      writeFileSync(audioPath, Buffer.from('ID3'))
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T02:00:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )

      const initial = generateGraph(tempDir, { noHtml: true })
      const initialGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(initialGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            source_url: 'https://example.com/podcast/episodes/1',
          }),
        ]),
      )

      await delay(10)
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T02:05:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(updated.changedFiles).toBeGreaterThan(0)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T02:05:00Z',
          }),
        ]),
      )
    })
  })

  test.runIf(process.platform !== 'win32')('preserves symlink-following local media files during incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const mediaDir = join(tempDir, 'media')
      const targetPath = join(mediaDir, 'episode.mp3')
      const linkPath = join(tempDir, 'episode-link.mp3')
      mkdirSync(mediaDir, { recursive: true })
      writeFileSync(targetPath, Buffer.from('ID3'))
      symlinkSync(targetPath, linkPath)

      const initial = generateGraph(tempDir, { followSymlinks: true, noHtml: true })
      const initialGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(initialGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode-link.mp3',
            source_file: linkPath,
          }),
        ]),
      )

      const updated = generateGraph(tempDir, { update: true, followSymlinks: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(updated.deletedFiles).toBe(0)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode-link.mp3',
            source_file: linkPath,
          }),
        ]),
      )
    })
  })

  test('preserves schema version during incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      const helperPath = join(tempDir, 'helper.py')
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n', 'utf8')
      writeFileSync(helperPath, 'def helper():\n    return 1\n', 'utf8')

      const initial = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        schema_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
        hyperedges?: Array<Record<string, unknown>>
      }

      graphData.schema_version = 2
      graphData.nodes = graphData.nodes.map((node) =>
        node.label === 'helper()'
          ? {
              ...node,
              layer: 'semantic',
              provenance: [{ capability_id: 'test:seed-helper', stage: 'seed' }],
            }
          : node,
      )
      writeFileSync(initial.graphPath, `${JSON.stringify(graphData, null, 2)}\n`, 'utf8')

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n\ndef other():\n    return greet()\n', 'utf8')

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        schema_version?: number
        nodes: Array<Record<string, unknown>>
      }

      expect(updatedGraphData.schema_version).toBe(2)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'helper()',
            layer: 'semantic',
            provenance: [expect.objectContaining({ capability_id: 'test:seed-helper' })],
          }),
        ]),
      )
    })
  })

  test('re-extracts only changed files during update while retaining unchanged graph context', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      const helperPath = join(tempDir, 'helper.py')
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n', 'utf8')
      writeFileSync(helperPath, 'def helper():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n\ndef other():\n    return greet()\n', 'utf8')

      vi.resetModules()
      const actualExtractModule = await vi.importActual<typeof import('../../src/pipeline/extract.js')>('../../src/pipeline/extract.js')
      const extractSpy = vi.fn(actualExtractModule.extract)
      vi.doMock('../../src/pipeline/extract.js', () => ({
        ...actualExtractModule,
        extract: extractSpy,
      }))

      try {
        const generateModule = await import('../../src/infrastructure/generate.js')
        const result = generateModule.generateGraph(tempDir, { update: true, noHtml: true })
        const graph = loadGraph(result.graphPath)

        expect(extractSpy).toHaveBeenCalledTimes(1)
        expect(normalizeAssertionPaths(extractSpy.mock.calls[0]?.[0] ?? [])).toEqual([normalizeAssertionPath(sourcePath)])
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'helper()')).toBe(true)
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'other()')).toBe(true)
      } finally {
        vi.doUnmock('../../src/pipeline/extract.js')
        vi.resetModules()
      }
    })
  })

  test('writes optional wiki, obsidian, svg, graphml, and cypher artifacts when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const obsidianDir = join(tempDir, 'vault')
      const result = generateGraph(tempDir, {
        wiki: true,
        obsidian: true,
        obsidianDir,
        svg: true,
        graphml: true,
        neo4j: true,
      })

      expect(existsSync(join(tempDir, 'out', 'wiki', 'index.md'))).toBe(true)
      expect(existsSync(join(obsidianDir, '.obsidian', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.svg'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.graphml'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'cypher.txt'))).toBe(true)
      expect(result.wikiPath).toBe(join(tempDir, 'out', 'wiki'))
      expect(result.obsidianPath).toBe(obsidianDir)
      expect(result.svgPath).toBe(join(tempDir, 'out', 'graph.svg'))
      expect(result.graphmlPath).toBe(join(tempDir, 'out', 'graph.graphml'))
      expect(result.cypherPath).toBe(join(tempDir, 'out', 'cypher.txt'))
    })
  })

  test('generates semantic community labels in reports and graph json metadata', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { noHtml: true })
      const report = readFileSync(result.reportPath, 'utf8')
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        community_labels?: Record<string, string>
      }

      expect(report).toContain('Infrastructure Install')
      expect(report).toContain('Pipeline Export')
      expect(report).not.toContain('Community 0 - "Community 0"')
      expect(graphData.community_labels).toMatchObject({
        0: expect.any(String),
      })
      expect(Object.values(graphData.community_labels ?? {})).toEqual(expect.arrayContaining(['Infrastructure Install', 'Pipeline Export']))
    })
  })

  test('propagates forced overview html mode through generateGraph', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { htmlMode: 'overview' })
      expect(result.htmlPath).not.toBeNull()
      if (!result.htmlPath) {
        throw new Error('Expected htmlPath to be written when HTML export is enabled')
      }

      const overview = readFileSync(result.htmlPath, 'utf8')

      expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('Large graph mode enabled')]))
      expect(overview).toContain('Overview-first large-graph mode')
      expect(readFileSync(join(tempDir, 'out', 'graph-pages', 'community-0.html'), 'utf8')).toContain('Back to overview')
    })
  })

  test('generates directed code graphs by default and preserves one-way traversal semantics', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'backend'), { recursive: true })
      mkdirSync(join(tempDir, 'shared'), { recursive: true })
      writeFileSync(
        join(tempDir, 'backend', 'api.ts'),
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser() {',
          '  return createSession()',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(tempDir, 'shared', 'auth.ts'),
        [
          'export function createSession() {',
          "  return 'session'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir, { noHtml: true })
      const graph = loadGraph(result.graphPath)
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as { directed?: boolean }

      expect(graph.isDirected()).toBe(true)
      expect(graphData.directed).toBe(true)
      expect(callChains(graph, 'loginUser()', 'createSession()')).toEqual(
        expect.arrayContaining([['loginUser()', 'createSession()']]),
      )
      expect(callChains(graph, 'createSession()', 'loginUser()')).toEqual([])
      expect(analyzeImpact(graph, {}, { label: 'createSession()' }).direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'loginUser()' })]),
      )
      expect(analyzeImpact(graph, {}, { label: 'loginUser()' }).direct_dependents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'createSession()' })]),
      )
    })
  })

  test('allows callers to explicitly generate an undirected visualization graph', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return helper()\n\ndef helper():\n    return 1\n', 'utf8')

      const result = generateGraph(tempDir, { directed: false })
      const graph = loadGraph(result.graphPath)

      expect(graph.isDirected()).toBe(false)
      expect(readFileSync(result.reportPath, 'utf8')).toContain('# Graph Report')
      expect(result.htmlPath).not.toBeNull()
      expect(result.htmlPath && existsSync(result.htmlPath)).toBe(true)
    })
  })

  test('makes a directed-to-undirected cluster-only downgrade explicit and disables directional analysis', () => {
    withTempDir((tempDir) => {
      writeFileSync(
        join(tempDir, 'main.py'),
        'def alpha():\n    return beta()\n\ndef beta():\n    return alpha()\n',
        'utf8',
      )
      const directedResult = generateGraph(tempDir, { noHtml: true })
      const directedGraph = loadGraph(directedResult.graphPath)
      expect(directedGraph.isDirected()).toBe(true)
      expect(callChains(directedGraph, 'alpha()', 'beta()')).not.toEqual([])
      expect(callChains(directedGraph, 'beta()', 'alpha()')).not.toEqual([])

      const downgraded = generateGraph(tempDir, { clusterOnly: true, directed: false, noHtml: true })
      const undirectedGraph = loadGraph(downgraded.graphPath)

      expect(undirectedGraph.isDirected()).toBe(false)
      expect(undirectedGraph.numberOfEdges()).toBeLessThan(directedGraph.numberOfEdges())
      expect(downgraded.notes).toContain('Migrated the existing graph from directed to undirected edge traversal.')
      expect(() => callChains(undirectedGraph, 'alpha()', 'beta()')).toThrow(
        'Call-chain analysis requires a directed graph',
      )
    })
  })

  test('migrates a legacy undirected graph during an unchanged update', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      const legacy = generateGraph(tempDir, { directed: false, noHtml: true })
      expect(loadGraph(legacy.graphPath).isDirected()).toBe(false)

      const updated = generateGraph(tempDir, { update: true, noHtml: true })

      expect(loadGraph(updated.graphPath).isDirected()).toBe(true)
      expect(updated.extractedFiles).toBeGreaterThan(0)
      expect(updated.notes).toContain('Existing graph was undirected, so --update rebuilt the full graph with directed edges.')
    })
  })

  test('refuses to guess lost edge directions during cluster-only regeneration', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      generateGraph(tempDir, { directed: false, noHtml: true })

      expect(() => generateGraph(tempDir, { clusterOnly: true, noHtml: true })).toThrow(
        '--cluster-only cannot safely recover edge directions from an undirected graph.',
      )
    })
  })

  test('writes root_path into graph.json', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        root_path?: string
      }

      expect(graphData.root_path).toBe(tempDir)
    })
  })

  test('resolves renders proxy edges to real component nodes across files', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'Button.tsx'),
        ['export function Button() {', '  return <span>btn</span>', '}'].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(tempDir, 'src', 'App.tsx'),
        ["import { Button } from './Button'", 'export function App() {', '  return <Button />', '}'].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        nodes: Array<{ id: string; label: string; node_kind?: string }>
        links: Array<{ source: string; target: string; relation: string }>
      }

      const buttonNode = graphData.nodes.find((n) => n.label === 'Button()' && n.node_kind === 'component')
      const appNode = graphData.nodes.find((n) => n.label === 'App()' && n.node_kind === 'component')

      expect(buttonNode).toBeTruthy()
      expect(appNode).toBeTruthy()

      // The renders edge from App → Button should resolve to the real Button node (not proxy)
      const rendersEdge = graphData.links.find(
        (e) => e.source === appNode?.id && e.target === buttonNode?.id && e.relation === 'renders',
      )
      expect(rendersEdge).toBeTruthy()

      // No proxy edges should remain
      const proxyEdges = graphData.links.filter((e) => e.relation === 'renders' && e.target.endsWith('__jsx_proxy'))
      expect(proxyEdges).toHaveLength(0)
    })
  })

  test('returns structured extraction and cache metrics for generate, update, and cluster-only flows', async () => {
    await withTempDirAsync(async (tempDir) => {
      mkdirSync(join(tempDir, 'src'), { recursive: true })
      mkdirSync(join(tempDir, 'docs'), { recursive: true })
      writeFileSync(join(tempDir, 'src', 'alpha.ts'), 'export function alpha(): number { return 1 }\n', 'utf8')
      writeFileSync(
        join(tempDir, 'src', 'beta.ts'),
        'import { alpha } from "./alpha"\nexport function beta(): number { return alpha() }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'docs', 'notes.md'), '# Notes\n', 'utf8')

      const legacy = generateGraph(tempDir, { noHtml: true })
      expect(legacy.extractableFiles).toBe(3)
      expect(legacy.extractedFiles).toBe(3)
      expect(legacy.cache).toBeNull()

      const spiCold = generateGraph(tempDir, { useSpi: true, noHtml: true })
      expect(spiCold.extractableFiles).toBe(3)
      expect(spiCold.extractedFiles).toBe(3)
      expect(spiCold.cache).toEqual(expect.objectContaining({
        strategy: 'spi',
        hit: false,
        reason: 'no-cache',
        fileCount: 2,
      }))

      const spiWarm = generateGraph(tempDir, { useSpi: true, noHtml: true })
      expect(spiWarm.extractableFiles).toBe(3)
      expect(spiWarm.extractedFiles).toBe(1)
      expect(spiWarm.cache).toEqual(expect.objectContaining({
        strategy: 'spi',
        hit: true,
        reason: 'fresh-cache',
        fileCount: 2,
      }))

      const updateNoop = generateGraph(tempDir, { update: true, noHtml: true })
      expect(updateNoop.extractableFiles).toBe(3)
      expect(updateNoop.changedFiles).toBe(0)
      expect(updateNoop.extractedFiles).toBe(3)
      expect(updateNoop.cache).toBeNull()
      expect(updateNoop.notes.join('\n')).toContain('Generation policy changed')

      await delay(10)
      writeFileSync(join(tempDir, 'src', 'beta.ts'), 'export function beta(): number { return 2 }\n', 'utf8')
      const updateChanged = generateGraph(tempDir, { update: true, noHtml: true })
      expect(updateChanged.extractableFiles).toBe(3)
      expect(updateChanged.changedFiles).toBe(1)
      expect(updateChanged.extractedFiles).toBe(1)
      expect(updateChanged.cache).toBeNull()

      const clusterOnly = generateGraph(tempDir, { clusterOnly: true, noHtml: true })
      expect(clusterOnly.mode).toBe('cluster-only')
      expect(clusterOnly.extractableFiles).toBe(3)
      expect(clusterOnly.extractedFiles).toBe(0)
      expect(clusterOnly.cache).toBeNull()
    })
  })
})
