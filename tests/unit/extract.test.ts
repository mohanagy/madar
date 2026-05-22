import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

import { strToU8, zipSync } from 'fflate'

import { cacheDir, fileHash } from '../../src/infrastructure/cache.js'
import { detect } from '../../src/pipeline/detect.js'
import { _makeId, collectFiles, extract, extractJs, extractPython } from '../../src/pipeline/extract.js'
import { MAX_TEXT_BYTES } from '../../src/shared/security.js'
import { normalizeAssertionPath, normalizeAssertionPaths } from './helpers/platform.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('extract', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'sadeem-extract-'))
  }

  function binaryIngestSidecarPath(assetPath: string): string {
    return join(dirname(assetPath), `.${basename(assetPath)}.sadeem-ingest.json`)
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

  function createMalformedMp4MetadataItem(typeBytes: Buffer, value: string): Buffer {
    const validItem = createMp4MetadataItem(typeBytes, value)
    return validItem.subarray(0, Math.max(8, validItem.length - 3))
  }

  function createTestM4aBuffer(
    metadata: { title: string; artist: string; album: string },
    options: {
      durationSeconds?: number
      sampleRate?: number
      channelCount?: number
      truncateMetadata?: boolean
      omitMovieHeaderDuration?: boolean
      includeTrackMdhdDuration?: boolean
    } = {},
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
    const trak = createMp4TrackBox('soun', stsd, {
      mdhd: options.includeTrackMdhdDuration ? createMp4MediaHeaderBox(durationSeconds) : null,
    })

    const metadataItems = options.truncateMetadata
      ? [
          createMalformedMp4MetadataItem(Buffer.from([0xa9, 0x6e, 0x61, 0x6d]), metadata.title),
        ]
      : [
          createMp4MetadataItem(Buffer.from([0xa9, 0x6e, 0x61, 0x6d]), metadata.title),
          createMp4MetadataItem(Buffer.from([0xa9, 0x41, 0x52, 0x54]), metadata.artist),
          createMp4MetadataItem(Buffer.from([0xa9, 0x61, 0x6c, 0x62]), metadata.album),
        ]
    const ilst = createMp4Atom('ilst', Buffer.concat(metadataItems))
    const meta = createMp4Atom('meta', Buffer.concat([Buffer.alloc(4), ilst]))
    const udta = createMp4Atom('udta', meta)

    return Buffer.concat([
      createMp4Atom('ftyp', Buffer.from('M4A 0000', 'ascii')),
      createMp4Atom(
        'moov',
        Buffer.concat([
          ...(options.omitMovieHeaderDuration ? [] : [createMp4Atom('mvhd', mvhdPayload)]),
          trak,
          udta,
        ]),
      ),
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
      invalidTrailingInfoSeekHead?: boolean
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
    const invalidTrailingInfoSeekHead = options.invalidTrailingInfoSeekHead ?? false
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
    let seekHeadSpecs: Array<{
      includeInfo: boolean
      includeTracks: boolean
      staleInfoTarget?: boolean
      staleTracksTarget?: boolean
      invalidInfoTarget?: boolean
    }> = useSeekHead
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
    if (useSeekHead && invalidTrailingInfoSeekHead) {
      seekHeadSpecs = [
        ...seekHeadSpecs,
        { includeInfo: true, includeTracks: false, invalidInfoTarget: true },
      ]
    }
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
        const invalidInfoPosition = infoPosition + tracks.length + 65_536
        const nextSeekHeads = seekHeadSpecs.map((spec) => createEbmlSeekHeadEntries([
          ...(spec.includeInfo ? [{
            targetId: EBML_INFO_ID,
            position: spec.invalidInfoTarget ? invalidInfoPosition : spec.staleInfoTarget ? (staleInfoPosition ?? 0) : infoPosition,
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

  function createFakeMvhdTaggedMp4Buffer(durationSeconds: number, timescale: number = 1_000): Buffer {
    const fakeMvhd = Buffer.alloc(24)
    fakeMvhd.write('mvhd', 0, 'ascii')
    fakeMvhd.writeUInt32BE(0, 4)
    fakeMvhd.writeUInt32BE(0, 8)
    fakeMvhd.writeUInt32BE(0, 12)
    fakeMvhd.writeUInt32BE(timescale, 16)
    fakeMvhd.writeUInt32BE(Math.round(durationSeconds * timescale), 20)

    return Buffer.concat([
      createMp4Atom('ftyp', Buffer.from('isom0000', 'ascii')),
      createMp4Atom('free', fakeMvhd),
    ])
  }

  function createLargeFakeTailTaggedMp4Buffer(durationSeconds: number, totalBytes: number = 270_000, timescale: number = 1_000): Buffer {
    const fakeMoov = createMp4Atom('moov', createMp4Atom('mvhd', (() => {
      const mvhdPayload = Buffer.alloc(20)
      mvhdPayload.writeUInt32BE(0, 0)
      mvhdPayload.writeUInt32BE(0, 4)
      mvhdPayload.writeUInt32BE(0, 8)
      mvhdPayload.writeUInt32BE(timescale, 12)
      mvhdPayload.writeUInt32BE(Math.round(durationSeconds * timescale), 16)
      return mvhdPayload
    })()))
    const ftyp = createMp4Atom('ftyp', Buffer.from('isom0000', 'ascii'))
    const mdatPayloadLength = totalBytes - ftyp.length - 8
    const mdatPayload = Buffer.alloc(mdatPayloadLength, 0)
    fakeMoov.copy(mdatPayload, Math.max(0, mdatPayload.length - fakeMoov.length))

    return Buffer.concat([ftyp, createMp4Atom('mdat', mdatPayload)])
  }

  function createMalformedShortFmtWavBuffer(): Buffer {
    const buffer = Buffer.alloc(44)
    buffer.write('RIFF', 0, 'ascii')
    buffer.writeUInt32LE(buffer.length - 8, 4)
    buffer.write('WAVE', 8, 'ascii')
    buffer.write('fmt ', 12, 'ascii')
    buffer.writeUInt32LE(4, 16)
    buffer.writeUInt32LE(0x00020000, 20)
    buffer.write('data', 24, 'ascii')
    buffer.writeUInt32LE(4, 28)
    buffer.writeUInt32LE(8, 32)
    return buffer
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
      truncateVideoFormat?: boolean
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
      createRiffChunk(
        'strf',
        options.truncateVideoFormat
          ? createAviBitmapInfoHeader(width, height).subarray(0, 8)
          : createAviBitmapInfoHeader(width, height),
      ),
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

  function encodeSynchsafeInteger(value: number): Buffer {
    return Buffer.from([
      (value >> 21) & 0x7f,
      (value >> 14) & 0x7f,
      (value >> 7) & 0x7f,
      value & 0x7f,
    ])
  }

  function createId3Frame(frameId: string, payload: Buffer, version: 3 | 4 = 3): Buffer {
    const sizeBuffer = version === 4 ? encodeSynchsafeInteger(payload.length) : Buffer.alloc(4)
    if (version !== 4) {
      sizeBuffer.writeUInt32BE(payload.length, 0)
    }

    const frame = Buffer.alloc(10 + payload.length)
    frame.write(frameId, 0, 'ascii')
    sizeBuffer.copy(frame, 4)
    payload.copy(frame, 10)
    return frame
  }

  function createId3v23TextFrame(frameId: string, value: string): Buffer {
    const text = Buffer.from(value, 'utf8')
    const payload = Buffer.concat([Buffer.from([3]), text])
    return createId3Frame(frameId, payload, 3)
  }

  function createId3v23Frame(frameId: string, payload: Buffer): Buffer {
    return createId3Frame(frameId, payload, 3)
  }

  function createId3ExtendedHeader(version: 3 | 4): Buffer {
    if (version === 3) {
      const header = Buffer.alloc(10)
      header.writeUInt32BE(6, 0)
      header.writeUInt16BE(0, 4)
      header.writeUInt32BE(0, 6)
      return header
    }

    const header = Buffer.alloc(6)
    encodeSynchsafeInteger(6).copy(header, 0)
    header[4] = 1
    header[5] = 0
    return header
  }

  function createTestMp3Id3Buffer(
    metadata: { title: string; artist: string; album: string },
    options: { version?: 3 | 4; extendedHeader?: boolean } = {},
  ): Buffer {
    const version = options.version ?? 3
    const frames = Buffer.concat([
      createId3Frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.title, 'utf8')]), version),
      createId3Frame('TPE1', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.artist, 'utf8')]), version),
      createId3Frame('TALB', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.album, 'utf8')]), version),
    ])
    const extendedHeader = options.extendedHeader ? createId3ExtendedHeader(version) : Buffer.alloc(0)
    const header = Buffer.alloc(10)
    header.write('ID3', 0, 'ascii')
    header[3] = version
    header[4] = 0
    header[5] = options.extendedHeader ? 0x40 : 0
    encodeSynchsafeInteger(extendedHeader.length + frames.length).copy(header, 6)
    return Buffer.concat([header, extendedHeader, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
  }

  function createMalformedUtf16Mp3Buffer(): Buffer {
    const frames = Buffer.concat([
      createId3v23Frame('TIT2', Buffer.from([2, 0xff])),
    ])
    const header = Buffer.alloc(10)
    header.write('ID3', 0, 'ascii')
    header[3] = 3
    header[4] = 0
    encodeSynchsafeInteger(frames.length).copy(header, 6)
    return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
  }

  function createMalformedV24SynchsafeSizeMp3Buffer(metadata: { title: string; artist: string; album: string }): Buffer {
    const frames = Buffer.concat([
      createId3Frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.title, 'utf8')]), 4),
      createId3Frame('TPE1', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.artist, 'utf8')]), 4),
      createId3Frame('TALB', Buffer.concat([Buffer.from([3]), Buffer.from(metadata.album, 'utf8')]), 4),
    ])
    const padding = Buffer.alloc(128)
    const header = Buffer.alloc(10)
    header.write('ID3', 0, 'ascii')
    header[3] = 4
    header[4] = 0
    header[9] = 0x80 | frames.length
    return Buffer.concat([header, frames, padding, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
  }

  function createLargeMp3Id3Buffer(metadata: { title: string; artist: string; album: string }, trailingFrameBytes: number = 300_000): Buffer {
    const frames = Buffer.concat([
      createId3v23TextFrame('TIT2', metadata.title),
      createId3v23TextFrame('TPE1', metadata.artist),
      createId3v23TextFrame('TALB', metadata.album),
      createId3v23Frame('APIC', Buffer.alloc(trailingFrameBytes, 0)),
    ])
    const header = Buffer.alloc(10)
    header.write('ID3', 0, 'ascii')
    header[3] = 3
    header[4] = 0
    encodeSynchsafeInteger(frames.length).copy(header, 6)
    return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
  }

  function createVorbisCommentBody(metadata: { title: string; artist: string; album: string }): Buffer {
    const vendor = Buffer.from('sadeem', 'utf8')
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
    options: {
      durationSeconds?: number
      sampleRate?: number
      channelCount?: number
      leadingPaddingBytes?: number
      truncateCommentBlock?: boolean
    } = {},
  ): Buffer {
    const durationSeconds = options.durationSeconds ?? 3.75
    const sampleRate = options.sampleRate ?? 48_000
    const channelCount = options.channelCount ?? 2
    const streamInfoBlock = createFlacMetadataBlock(0, createFlacStreamInfo(durationSeconds, sampleRate, channelCount), false)
    const leadingPaddingBlock = options.leadingPaddingBytes
      ? createFlacMetadataBlock(1, Buffer.alloc(options.leadingPaddingBytes, 0), false)
      : null
    const commentBlock = createFlacMetadataBlock(4, createVorbisCommentBody(metadata), true)
    const serializedCommentBlock = options.truncateCommentBlock
      ? commentBlock.subarray(0, Math.min(commentBlock.length, 8))
      : commentBlock
    return Buffer.concat([
      Buffer.from('fLaC', 'ascii'),
      streamInfoBlock,
      ...(leadingPaddingBlock ? [leadingPaddingBlock] : []),
      serializedCommentBlock,
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

  function createOggVorbisStreamPages(
    metadata: { title: string; artist: string; album: string },
    options: { durationSeconds?: number; sampleRate?: number; channelCount?: number; bitstreamSerialNumber?: number } = {},
  ): Buffer[] {
    const durationSeconds = options.durationSeconds ?? 2.5
    const sampleRate = options.sampleRate ?? 44_100
    const channelCount = options.channelCount ?? 2
    const totalSamples = BigInt(Math.round(durationSeconds * sampleRate))
    const serial = options.bitstreamSerialNumber ?? 17
    return [
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
    ]
  }

  function createTestOggVorbisBuffer(
    metadata: { title: string; artist: string; album: string },
    options: { durationSeconds?: number; sampleRate?: number; channelCount?: number; bitstreamSerialNumber?: number } = {},
  ): Buffer {
    return Buffer.concat(createOggVorbisStreamPages(metadata, options))
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

  function expectSourceEntriesToUseCapability(result: ReturnType<typeof extract>, sourceFile: string, capabilityId: string): void {
    const sourceNodes = result.nodes.filter((node) => node.source_file === sourceFile)
    const sourceEdges = result.edges.filter((edge) => edge.source_file === sourceFile)

    expect(sourceNodes.length).toBeGreaterThan(0)
    expect(sourceEdges.length).toBeGreaterThan(0)
    expect(sourceNodes.every((node) => node.layer === 'base')).toBe(true)
    expect(sourceEdges.every((edge) => edge.layer === 'base')).toBe(true)
    expect(sourceNodes.every((node) => Array.isArray(node.provenance) && node.provenance.length > 0)).toBe(true)
    expect(sourceEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)

    for (const node of sourceNodes) {
      expect(node).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: capabilityId, stage: 'extract' })],
      })
    }

    for (const edge of sourceEdges) {
      expect(edge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: capabilityId, stage: 'extract' })],
      })
    }
  }

  it('builds stable ids without leading punctuation', () => {
    expect(_makeId('_auth')).toBe('auth')
    expect(_makeId('.httpx._client')).toBe('httpx_client')
    expect(_makeId('foo', 'Bar')).toBe(_makeId('foo', 'Bar'))
    expect(_makeId('__init__').startsWith('_')).toBe(false)
    expect(_makeId('__init__').endsWith('_')).toBe(false)
  })

  it('extracts python classes and methods', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample.py'))
    const labels = result.nodes.map((node) => node.label)

    expect(labels).toContain('Transformer')
    expect(labels.some((label) => label.includes('__init__') || label.includes('forward'))).toBe(true)
  })

  it('emits explicit base-layer provenance during raw code extraction', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample.py'))

    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.edges.length).toBeGreaterThan(0)
    expect(result.nodes.every((node) => node.layer === 'base')).toBe(true)
    expect(result.edges.every((edge) => edge.layer === 'base')).toBe(true)
    expect(result.nodes.every((node) => Array.isArray(node.provenance) && node.provenance.length > 0)).toBe(true)
    expect(result.edges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
    expect(result.nodes[0]?.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })]))
    expect(result.edges[0]?.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })]))
  })

  it('keeps python structural edges deterministic', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample.py'))
    const structural = new Set(['contains', 'method', 'inherits', 'imports', 'imports_from'])
    for (const edge of result.edges) {
      if (structural.has(edge.relation)) {
        expect(edge.confidence).toBe('EXTRACTED')
      }
    }
  })

  it('extracts python docstrings and rationale comments into rationale nodes', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'auth.py')
      writeFileSync(
        filePath,
        [
          '"""This module handles authentication and session management."""',
          '',
          '# NOTE: Keep the login flow small for interactive use.',
          '',
          'class AuthClient:',
          '    """HTTP client for OAuth2 flows with PKCE support."""',
          '',
          '    def login(self):',
          '        """Use a short-lived token for browser sign-ins."""',
          '        # WHY: Retry after 429 responses to respect upstream throttling.',
          '        return helper()',
          '',
          'def helper():',
          '    pass',
        ].join('\n'),
        'utf8',
      )

      const result = extractPython(filePath)
      const rationaleNodes = result.nodes.filter((node) => node.file_type === 'rationale')
      const rationaleLabels = rationaleNodes.map((node) => node.label)
      const rationaleEdges = result.edges.filter((edge) => edge.relation === 'rationale_for')
      const rationaleTargets = new Set(result.edges.filter((edge) => edge.relation === 'rationale_for').map((edge) => edge.target))
      const fileNodeId = result.nodes.find((node) => node.label === 'auth.py')?.id
      const classNodeId = result.nodes.find((node) => node.label === 'AuthClient')?.id
      const methodNodeId = result.nodes.find((node) => node.label === '.login()')?.id

      expect(rationaleLabels.some((label) => label.includes('This module handles authentication'))).toBe(true)
      expect(rationaleLabels.some((label) => label.includes('NOTE: Keep the login flow small'))).toBe(true)
      expect(rationaleLabels.some((label) => label.includes('HTTP client for OAuth2 flows'))).toBe(true)
      expect(rationaleLabels.some((label) => label.includes('Use a short-lived token'))).toBe(true)
      expect(rationaleLabels.some((label) => label.includes('WHY: Retry after 429 responses'))).toBe(true)
      expect(rationaleTargets.has(fileNodeId ?? '')).toBe(true)
      expect(rationaleTargets.has(classNodeId ?? '')).toBe(true)
      expect(rationaleTargets.has(methodNodeId ?? '')).toBe(true)
      expect(rationaleNodes.every((node) => node.layer === 'base')).toBe(true)
      expect(rationaleEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(rationaleNodes.every((node) => Array.isArray(node.provenance) && node.provenance.length > 0)).toBe(true)
      expect(rationaleEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(rationaleNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'base',
            provenance: [expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })],
          }),
        ]),
      )
      expect(rationaleEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'base',
            provenance: [expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })],
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts async python functions and methods with rationale and call edges', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'async_client.py')
      writeFileSync(
        filePath,
        [
          'class AsyncClient:',
          '    async def fetch(self):',
          '        """Fetch records from the upstream service."""',
          '        return await self._request()',
          '',
          '    async def _request(self):',
          '        return await helper()',
          '',
          'async def helper():',
          '    return 1',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const rationaleNodes = result.nodes.filter((node) => node.file_type === 'rationale')
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))
      const rationaleEdges = result.edges.filter((edge) => edge.relation === 'rationale_for')
      const fetchId = result.nodes.find((node) => node.label === '.fetch()')?.id
      const rationaleTargets = new Set(result.edges.filter((edge) => edge.relation === 'rationale_for').map((edge) => edge.target))

      expect(labels).toContain('AsyncClient')
      expect(labels).toContain('.fetch()')
      expect(labels).toContain('._request()')
      expect(labels).toContain('helper()')
      expect(calls.has('.fetch()->._request()')).toBe(true)
      expect(calls.has('._request()->helper()')).toBe(true)
      expect(rationaleTargets.has(fetchId ?? '')).toBe(true)
      expect(rationaleNodes.every((node) => node.layer === 'base')).toBe(true)
      expect(rationaleEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(rationaleNodes.every((node) => Array.isArray(node.provenance) && node.provenance.length > 0)).toBe(true)
      expect(rationaleEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(rationaleNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'base',
            provenance: [expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })],
          }),
        ]),
      )
      expect(rationaleEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'base',
            provenance: [expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })],
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts python calls without self loops or duplicates', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample_calls.py'))
    const callEdges = result.edges.filter((edge) => edge.relation === 'calls')
    const callPairs = callEdges.map((edge) => `${edge.source}->${edge.target}`)

    expect(callEdges.length).toBeGreaterThan(0)
    expect(callPairs.length).toBe(new Set(callPairs).size)

    for (const edge of callEdges) {
      expect(edge.confidence).toBe('EXTRACTED')
      expect(edge.weight).toBe(1)
      expect(edge.source).not.toBe(edge.target)
    }
  })

  it('extracts the expected python call relationships', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample_calls.py'))
    const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${edge.source}->${edge.target}`))
    const nodeByLabel = new Map(result.nodes.map((node) => [node.label, node.id]))

    expect(calls.has(`${nodeByLabel.get('run_analysis()')}->${nodeByLabel.get('compute_score()')}`)).toBe(true)
    expect(calls.has(`${nodeByLabel.get('run_analysis()')}->${nodeByLabel.get('normalize()')}`)).toBe(true)
    expect(calls.has(`${nodeByLabel.get('.process()')}->${nodeByLabel.get('run_analysis()')}`)).toBe(true)
  })

  it('resolves cross-file python imports into inferred class relationships', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const helpersPath = join(root, 'helpers.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(modelsPath, ['class Response:', '    pass', '', 'class BaseAuth:', '    pass'].join('\n'), 'utf8')
      writeFileSync(helpersPath, ['def normalize_token(value):', '    return value.strip().lower()'].join('\n'), 'utf8')

      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          'from .helpers import normalize_token',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self, token) -> ApiResponse:',
          '        normalize_token(token)',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const result = extract([authPath, modelsPath, helpersPath])
      const digestAuthId = result.nodes.find((node) => node.label === 'DigestAuth')?.id
      const responseId = result.nodes.find((node) => node.label === 'Response')?.id
      const baseAuthId = result.nodes.find((node) => node.label === 'BaseAuth')?.id
      const buildId = result.nodes.find((node) => node.label === '.build()' && node.source_file === authPath)?.id
      const normalizeTokenId = result.nodes.find((node) => node.label === 'normalize_token()')?.id

      expect(digestAuthId).toBeTruthy()
      expect(responseId).toBeTruthy()
      expect(baseAuthId).toBeTruthy()
      expect(buildId).toBeTruthy()
      expect(normalizeTokenId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === digestAuthId && edge.target === responseId && edge.relation === 'uses' && edge.confidence === 'INFERRED')).toBe(
        true,
      )
      expect(
        result.edges.some((edge) => edge.source === digestAuthId && edge.target === baseAuthId && edge.relation === 'inherits' && edge.confidence === 'INFERRED'),
      ).toBe(true)
      expect(
        result.edges.some(
          (edge) => edge.source === buildId && edge.target === normalizeTokenId && edge.relation === 'calls' && edge.confidence === 'INFERRED',
        ),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts FastAPI router, route, endpoint, and dependency edges across python files', () => {
    const root = createTempRoot()
    try {
      const depsPath = join(root, 'deps.py')
      const apiPath = join(root, 'api.py')

      writeFileSync(depsPath, ['def get_db():', '    return "db"'].join('\n'), 'utf8')
      writeFileSync(
        apiPath,
        [
          'from fastapi import APIRouter, Depends',
          'from .deps import get_db',
          '',
          'router = APIRouter(prefix="/api")',
          '',
          '@router.get("/users")',
          'async def list_users(db = Depends(get_db)):',
          '    return {"db": db}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, depsPath])
      const routerId = result.nodes.find((node) => node.label === 'router' && node.framework_role === 'fastapi_router')?.id
      const routeId = result.nodes.find((node) => node.label === 'GET /api/users' && node.framework_role === 'fastapi_route')?.id
      const endpointId = result.nodes.find((node) => node.label === 'list_users()')?.id
      const dependencyId = result.nodes.find((node) => node.label === 'get_db()' && node.source_file === depsPath)?.id

      expect(routerId).toBeTruthy()
      expect(routeId).toBeTruthy()
      expect(endpointId).toBeTruthy()
      expect(dependencyId).toBeTruthy()
      expect(result.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: routerId,
            label: 'router',
            framework: 'fastapi',
            framework_role: 'fastapi_router',
            node_kind: 'router',
          }),
          expect.objectContaining({
            id: routeId,
            label: 'GET /api/users',
            framework: 'fastapi',
            framework_role: 'fastapi_route',
            node_kind: 'route',
            route_path: '/api/users',
            http_method: 'GET',
          }),
          expect.objectContaining({
            id: endpointId,
            framework: 'fastapi',
            framework_role: 'fastapi_endpoint',
          }),
          expect.objectContaining({
            id: dependencyId,
            framework: 'fastapi',
            framework_role: 'fastapi_dependency',
          }),
        ]),
      )
      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: routerId, target: routeId, relation: 'registers_route' }),
          expect.objectContaining({ source: endpointId, target: routeId, relation: 'handles_route' }),
          expect.objectContaining({ source: routeId, target: endpointId, relation: 'depends_on' }),
          expect.objectContaining({ source: endpointId, target: dependencyId, relation: 'depends_on' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts typescript classes, methods, functions, and calls', () => {
    const result = extractJs(join(FIXTURES_DIR, 'sample.ts'))
    const labels = result.nodes.map((node) => node.label)
    const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
    const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

    expect(labels).toContain('HttpClient')
    expect(labels.some((label) => label.includes('get'))).toBe(true)
    expect(labels.some((label) => label.includes('post'))).toBe(true)
    expect(labels.some((label) => label.includes('buildHeaders'))).toBe(true)
    expect(calls.has('.post()->.get()')).toBe(true)
  })

  it('stores AST-bounded snippets for extracted typescript symbols', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'auth.ts')
      writeFileSync(
        filePath,
        [
          'class AuthService {',
          '  login() {',
          '    return true',
          '  }',
          '}',
          '',
          'function logout() {',
          '  return false',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const authService = result.nodes.find((node) => node.label === 'AuthService')
      const logout = result.nodes.find((node) => node.label === 'logout()')

      expect(authService?.source_location).toBe('L1-L5')
      expect(authService?.snippet).toContain('class AuthService {')
      expect(authService?.snippet).toContain('login() {')
      expect(logout?.source_location).toBe('L7-L9')
      expect(logout?.snippet).toContain('function logout() {')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts nested js/ts closures with local ownership and dynamic imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'loader.ts')
      writeFileSync(
        filePath,
        [
          'class Loader {',
          '  async load() {',
          '    const pick = async () => {',
          "      const feature = await import('./feature')",
          '      return this.request(feature)',
          '    }',
          '    return pick()',
          '  }',
          '',
          '  request(_feature: unknown) {',
          '    return true',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const loadId = result.nodes.find((node) => node.label === '.load()')?.id
      const pickId = result.nodes.find((node) => node.label === 'pick()')?.id
      const requestId = result.nodes.find((node) => node.label === '.request()')?.id
      const featureId = _makeId('feature')

      expect(loadId).toBeTruthy()
      expect(pickId).toBeTruthy()
      expect(requestId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loadId && edge.target === pickId && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loadId && edge.target === pickId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === pickId && edge.target === requestId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === pickId && edge.target === featureId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loadId && edge.target === requestId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts js/ts re-exports, import-equals, and CommonJS require imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'barrel.ts')
      writeFileSync(
        filePath,
        [
          "export { HttpClient } from './http-client'",
          "export * from './shared'",
          "import Config = require('./config')",
          "const path = require('node:path')",
          '',
          'function load() {',
          "  return require('./lazy')",
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const fileNodeId = result.nodes.find((node) => node.label === 'barrel.ts')?.id
      const loadId = result.nodes.find((node) => node.label === 'load()')?.id
      const imports = new Set(result.edges.filter((edge) => edge.relation === 'imports_from').map((edge) => `${edge.source}->${edge.target}`))

      expect(fileNodeId).toBeTruthy()
      expect(loadId).toBeTruthy()
      expect(imports.has(`${fileNodeId}->${_makeId('http-client')}`)).toBe(true)
      expect(imports.has(`${fileNodeId}->${_makeId('shared')}`)).toBe(true)
      expect(imports.has(`${fileNodeId}->${_makeId('config')}`)).toBe(true)
      expect(imports.has(`${fileNodeId}->${_makeId('path')}`)).toBe(true)
      expect(imports.has(`${loadId}->${_makeId('lazy')}`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts go structs, methods, functions, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.go')
      writeFileSync(
        filePath,
        [
          'package main',
          'import "net/http"',
          'type Client struct {}',
          'func (c *Client) Get() error {',
          '  return c.do()',
          '}',
          'func (c *Client) do() error {',
          '  return nil',
          '}',
          'func Build() {',
          '  helper()',
          '}',
          'func helper() {}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.Get()')
      expect(labels).toContain('.do()')
      expect(labels).toContain('Build()')
      expect(labels).toContain('helper()')
      expect(calls.has('.Get()->.do()')).toBe(true)
      expect(calls.has('Build()->helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts go interfaces and interface method signatures', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'interfaces.go')
      writeFileSync(
        filePath,
        [
          'package main',
          '',
          'type Runner interface {',
          '  Run() error',
          '}',
          '',
          'type Service struct {}',
          '',
          'func (s *Service) Run() error {',
          '  return helper()',
          '}',
          '',
          'func helper() error {',
          '  return nil',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const runnerId = result.nodes.find((node) => node.label === 'Runner')?.id
      const runnerMethodEdge = result.edges.find((edge) => edge.source === runnerId && edge.relation === 'method')
      const runnerMethodLabel = result.nodes.find((node) => node.id === runnerMethodEdge?.target)?.label

      expect(runnerId).toBeTruthy()
      expect(runnerMethodLabel).toBe('.Run()')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby classes, methods, functions, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.rb')
      writeFileSync(
        filePath,
        [
          "require 'net/http'",
          '',
          'class BaseClient',
          'end',
          '',
          'class ApiClient < BaseClient',
          '  def get',
          '    url = "https://example.com#anchor"; request()',
          '    msg = "Score: #{decorate()}"',
          '    label = "database#connection"; normalize()',
          '  end',
          '',
          '  def request',
          '  end',
          '',
          '  def normalize',
          '  end',

          '  def decorate',
          '  end',
          'end',
          '',
          'def helper',
          '  normalize_helper()',
          'end',
          '',
          'def normalize_helper',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('BaseClient')
      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(labels).toContain('.normalize()')
      expect(labels).toContain('.decorate()')
      expect(labels).toContain('helper()')
      expect(labels).toContain('normalize_helper()')
      expect(result.edges.some((edge) => edge.relation === 'inherits')).toBe(true)
      expect(result.edges.some((edge) => edge.relation === 'imports')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
      expect(calls.has('.get()->.normalize()')).toBe(true)
      expect(calls.has('.get()->.decorate()')).toBe(true)
      expect(calls.has('helper()->normalize_helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby command-style calls without parentheses', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'commands.rb')
      writeFileSync(
        filePath,
        ['class ApiClient', '  def get', '    request', '    normalize', '  end', '', '  def request', '  end', '', '  def normalize', '  end', 'end'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(calls.has('.get()->.request()')).toBe(true)
      expect(calls.has('.get()->.normalize()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby singleton method calls through constant receivers', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'singleton.rb')
      writeFileSync(filePath, ['class Client', '  def get', '    Client.build()', '  end', '', '  def self.build', '  end', 'end'].join('\n'), 'utf8')

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('.build()')
      expect(calls.has('.get()->.build()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby modules as containing owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'nested.rb')
      writeFileSync(filePath, ['module Httpx', '  class Client', '  end', 'end'].join('\n'), 'utf8')

      const result = extract([filePath])
      const moduleId = result.nodes.find((node) => node.label === 'Httpx')?.id
      const classId = result.nodes.find((node) => node.label === 'Client')?.id

      expect(moduleId).toBeTruthy()
      expect(classId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === moduleId && edge.target === classId && edge.relation === 'contains')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts zig structs, functions, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.zig')
      writeFileSync(
        filePath,
        [
          'const std = @import("std");',
          '',
          'const Client = struct {',
          '    pub fn get(self: *Client) void {',
          '        helper();',
          '    }',
          '};',
          '',
          'fn helper() void {',
          '}',

          'fn parse() !u8 {',
          '    return 1;',
          '}',
          '',
          'pub fn main() void {',
          '    helper();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('helper()')
      expect(labels).toContain('parse()')
      expect(labels).toContain('main()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->helper()')).toBe(true)
      expect(calls.has('main()->helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts elixir modules, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.ex')
      writeFileSync(
        filePath,
        ['defmodule ApiClient do', '  alias Models.Response', '', '  def get do', '    request()', '  end', '', '  def request do', '  end', 'end'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts julia structs, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.jl')
      writeFileSync(
        filePath,
        ['using LinearAlgebra', '', 'struct Client', 'end', '', 'function fetch(client)', '  normalize()', 'end', '', 'function normalize()', 'end'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('fetch()')
      expect(labels).toContain('normalize()')
      expect(result.edges.some((edge) => edge.relation === 'imports' || edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('fetch()->normalize()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts powershell classes, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.ps1')
      writeFileSync(
        filePath,
        [
          'Import-Module Microsoft.PowerShell.Utility',
          '',
          'class ApiClient {',
          '  [void] Get() {',
          '    Invoke-Request',
          '  }',
          '}',
          '',
          'function Invoke-Request {',
          '  Normalize-Response',
          '}',
          '',
          'function Normalize-Response {',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.Get()')
      expect(labels).toContain('Invoke-Request()')
      expect(labels).toContain('Normalize-Response()')
      expect(result.edges.some((edge) => edge.relation === 'imports' || edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.Get()->Invoke-Request()')).toBe(true)
      expect(calls.has('Invoke-Request()->Normalize-Response()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts objective-c classes, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.m')
      writeFileSync(
        filePath,
        [
          '#import <Foundation/Foundation.h>',
          '',
          '@interface Client : NSObject',
          '@end',
          '',
          '@implementation Client',
          '- (void)get {',
          '  [self request];',
          '}',
          '',
          '- (void)request {',
          '}',
          '@end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts lua tables, functions, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.lua')
      writeFileSync(
        filePath,
        ['local http = require("http")', 'local Client = {}', '', 'function Client:get()', '  request()', 'end', '', 'function request()', 'end'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('request()')
      expect(result.edges.some((edge) => edge.relation === 'imports')).toBe(true)
      expect(calls.has('.get()->request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts toc metadata and file references', () => {
    const root = createTempRoot()
    try {
      const tocPath = join(root, 'Addon.toc')
      const luaPath = join(root, 'Main.lua')
      writeFileSync(luaPath, 'function main()\nend\n', 'utf8')
      writeFileSync(tocPath, ['## Interface: 100000', '## Title: Sample Addon', 'Main.lua'].join('\n'), 'utf8')

      const result = extract([tocPath, luaPath])
      const labels = result.nodes.map((node) => node.label)
      const tocId = result.nodes.find((node) => node.label === 'Addon.toc')?.id
      const titleId = result.nodes.find((node) => node.label === 'Title: Sample Addon')?.id
      const luaId = result.nodes.find((node) => node.label === 'Main.lua')?.id
      const referenceEdge = result.edges.find((edge) => edge.source === tocId && edge.target === luaId && edge.relation === 'references')

      expect(labels).toContain('Addon.toc')
      expect(labels).toContain('Title: Sample Addon')
      expect(tocId).toBeTruthy()
      expect(titleId).toBeTruthy()
      expect(luaId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === tocId && edge.target === titleId && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === tocId && edge.target === luaId && edge.relation === 'references')).toBe(true)
      expect(referenceEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:toc', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts java classes, methods, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'Service.java')
      writeFileSync(filePath, ['import java.util.List;', 'class Service {', '  void run() {', '    helper();', '  }', '  void helper() {}', '}'].join('\n'), 'utf8')

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Service')
      expect(labels).toContain('.run()')
      expect(labels).toContain('.helper()')
      expect(calls.has('.run()->.helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts nested java classes under their enclosing owner', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'Service.java')
      writeFileSync(
        filePath,
        ['class Service {', '  static class Helper {', '    void run() {', '      ping();', '    }', '    void ping() {}', '  }', '}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const serviceId = result.nodes.find((node) => node.label === 'Service')?.id
      const helperId = result.nodes.find((node) => node.label === 'Helper')?.id
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(serviceId).toBeTruthy()
      expect(helperId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === serviceId && edge.target === helperId && edge.relation === 'contains')).toBe(true)
      expect(calls.has('.run()->.ping()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts java records as owners for their methods', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'UserRecord.java')
      writeFileSync(
        filePath,
        ['import java.util.List;', 'record UserRecord(String name) {', '  void emit() {', '    helper();', '  }', '  static void helper() {}', '}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))
      const recordId = result.nodes.find((node) => node.label === 'UserRecord')?.id

      expect(recordId).toBeTruthy()
      expect(labels).toContain('.emit()')
      expect(labels).toContain('.helper()')
      expect(result.edges.some((edge) => edge.source === recordId && edge.relation === 'method')).toBe(true)
      expect(calls.has('.emit()->.helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust impl methods and self calls as methods on the owner type', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'struct Worker {}',
          'impl Worker {',
          '  fn run(&self) {',
          '    self.helper();',
          '  }',
          '  fn helper(&self) {}',
          '}',
          'fn boot() {',
          '  Worker::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Worker')
      expect(labels).toContain('.run()')
      expect(labels).toContain('.helper()')
      expect(labels).toContain('boot()')
      expect(calls.has('.run()->.helper()')).toBe(true)
      expect(calls.has('boot()->.run()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust module ownership and pub use imports with method calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const moduleId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerId = result.nodes.find((node) => node.label === 'Worker')?.id
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('engine')
      expect(labels).toContain('Worker')
      expect(labels).toContain('.run()')
      expect(labels).toContain('.helper()')
      expect(labels).toContain('boot()')
      expect(moduleId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(fileId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === moduleId && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === moduleId && edge.target === workerId && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.run()->.helper()')).toBe(true)
      expect(calls.has('boot()->.run()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust trait signatures and impl conformance edges inside a module', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const runnerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Runner')?.target
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runnerRunId = result.edges.find((edge) => edge.source === runnerId && edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const workerRunId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target

      expect(engineId).toBeTruthy()
      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runnerRunId).toBeTruthy()
      expect(workerRunId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves imported rust traits for impl conformance without creating duplicate trait owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const traitsId = result.nodes.find((node) => node.label === 'traits')?.id
      const runnerNodes = result.nodes.filter((node) => node.label === 'Runner')
      const runnerId = result.edges.find((edge) => edge.source === traitsId && edge.relation === 'contains' && runnerNodes.some((node) => node.id === edge.target))?.target
      const workerId = result.nodes.find((node) => node.label === 'Worker')?.id

      expect(runnerNodes).toHaveLength(1)
      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === runnerId && edge.relation === 'contains')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves cross-file rust trait imports for impl conformance without placeholder owners', () => {
    const root = createTempRoot()
    try {
      const traitsPath = join(root, 'traits.rs')
      const workerPath = join(root, 'worker.rs')
      writeFileSync(
        traitsPath,
        ['pub trait Runner {', '  fn run(&self);', '}'].join('\n'),
        'utf8',
      )
      writeFileSync(
        workerPath,
        ['use crate::traits::Runner;', 'struct Worker {}', 'impl Runner for Worker {', '  fn run(&self) {}', '}'].join('\n'),
        'utf8',
      )

      const result = extract([workerPath, traitsPath])
      const workerFileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const workerId = result.nodes.find((node) => node.label === 'Worker')?.id
      const runnerNodes = result.nodes.filter((node) => node.label === 'Runner')
      const runnerId = runnerNodes[0]?.id

      expect(runnerNodes).toHaveLength(1)
      expect(workerFileId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runnerId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === workerFileId && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves aliased rust grouped-use calls onto imported owner methods without duplicate owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerNodes = result.nodes.filter((node) => node.label === 'Worker')
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = result.edges.find((edge) => edge.source === fileId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
      expect(result.nodes.some((node) => node.label === 'Client')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves aliased rust trait imports for impl conformance without creating duplicate trait owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const traitsId = result.nodes.find((node) => node.label === 'traits')?.id
      const runnerNodes = result.nodes.filter((node) => node.label === 'Runner')
      const runnerId = result.edges.find((edge) => edge.source === traitsId && edge.relation === 'contains' && runnerNodes.some((node) => node.id === edge.target))?.target
      const workerId = result.nodes.find((node) => node.label === 'Worker')?.id

      expect(runnerNodes).toHaveLength(1)
      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === runnerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
      expect(result.nodes.some((node) => node.label === 'AliasTrait')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves rust super paths for method calls inside nested modules', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const outerId = result.nodes.find((node) => node.label === 'outer')?.id
      const innerId = result.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const workerId = result.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = result.edges.find((edge) => edge.source === innerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves rust anchor-only super paths for free-function calls inside nested modules', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const topLevelRunId = result.edges.find((edge) => edge.source === fileId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const outerId = result.nodes.find((node) => node.label === 'outer')?.id
      const innerId = result.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const outerRunId = result.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const bootId = result.edges.find((edge) => edge.source === innerId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(topLevelRunId).toBeTruthy()
      expect(outerRunId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === outerRunId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === topLevelRunId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resolve missing rust anchor-only super paths onto unrelated free functions', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const bootId = result.nodes.find((node) => node.label === 'boot()')?.id
      const runId = result.nodes.find((node) => node.label === 'run()')?.id

      expect(bootId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not emit self-inherits edges for inherent rust impl blocks', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target

      expect(workerId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === workerId && edge.target === workerId && edge.relation === 'inherits')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-relative-path cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 54,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_outer', label: 'outer', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_inner', label: 'inner', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: '.run()', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_outer', target: 'stale_rust_inner', relation: 'contains' },
            { source: 'stale_rust_inner', target: 'stale_rust_boot', relation: 'contains' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const outerId = recovered.nodes.find((node) => node.label === 'outer')?.id
      const innerId = recovered.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const workerId = recovered.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = recovered.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && recovered.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = recovered.edges.find((edge) => edge.source === innerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-aliased-use cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 57,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_engine', label: 'engine', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: '.run()', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_engine', relation: 'contains' },
            { source: 'stale_rust_engine', target: 'stale_rust_worker', relation: 'contains' },
            { source: 'stale_rust_file', target: 'stale_rust_boot', relation: 'contains' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const engineId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const workerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = recovered.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && recovered.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = recovered.edges.find((edge) => edge.source === fileId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-anchor-only-relative-call cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 55,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_outer', label: 'outer', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_inner', label: 'inner', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: 'run()', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_outer', relation: 'contains' },
            { source: 'stale_rust_outer', target: 'stale_rust_inner', relation: 'contains' },
            { source: 'stale_rust_inner', target: 'stale_rust_boot', relation: 'contains' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const topLevelRunId = recovered.edges.find((edge) => edge.source === fileId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const outerId = recovered.nodes.find((node) => node.label === 'outer')?.id
      const innerId = recovered.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'inner')?.target
      const outerRunId = recovered.edges.find((edge) => edge.source === outerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'run()')?.target
      const bootId = recovered.edges.find((edge) => edge.source === innerId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(topLevelRunId).toBeTruthy()
      expect(outerRunId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === outerRunId && edge.relation === 'calls')).toBe(true)
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === topLevelRunId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-missing-anchor-only-relative-call cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 56,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: 'run()', file_type: 'code', source_file: filePath },
          ],
          edges: [{ source: 'stale_rust_boot', target: 'stale_rust_run', relation: 'calls' }],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const bootId = recovered.nodes.find((node) => node.label === 'boot()')?.id
      const runId = recovered.nodes.find((node) => node.label === 'run()')?.id

      expect(bootId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-imported-trait cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 53,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_traits', label: 'traits', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_runner_import', label: 'Runner', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_runner_module', label: 'Runner', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_traits', relation: 'contains' },
            { source: 'stale_rust_traits', target: 'stale_rust_runner_module', relation: 'contains' },
            { source: 'stale_rust_file', target: 'stale_rust_runner_import', relation: 'contains' },
            { source: 'stale_rust_worker', target: 'stale_rust_runner_import', relation: 'inherits' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const traitsId = recovered.nodes.find((node) => node.label === 'traits')?.id
      const runnerNodes = recovered.nodes.filter((node) => node.label === 'Runner')
      const runnerId = recovered.edges.find((edge) => edge.source === traitsId && edge.relation === 'contains' && runnerNodes.some((node) => node.id === edge.target))?.target
      const workerId = recovered.nodes.find((node) => node.label === 'Worker')?.id

      expect(runnerNodes).toHaveLength(1)
      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === runnerId && edge.relation === 'contains')).toBe(false)
      expect(recovered.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-ast-foundation cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 45,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const moduleId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const workerId = recovered.nodes.find((node) => node.label === 'Worker')?.id

      expect(moduleId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === moduleId && edge.relation === 'contains')).toBe(true)
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-inherent-impl-trait cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 52,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_engine', label: 'engine', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_engine', relation: 'contains' },
            { source: 'stale_rust_engine', target: 'stale_rust_worker', relation: 'contains' },
            { source: 'stale_rust_worker', target: 'stale_rust_worker', relation: 'inherits' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const engineId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const workerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target

      expect(workerId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === workerId && edge.target === workerId && edge.relation === 'inherits')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-trait-conformance cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 51,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_engine', label: 'engine', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_engine', relation: 'contains' },
            { source: 'stale_rust_engine', target: 'stale_rust_worker', relation: 'contains' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const engineId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const runnerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Runner')?.target
      const workerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target

      expect(runnerId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === workerId && edge.target === runnerId && edge.relation === 'inherits')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust generic impl methods under the owner type and keeps self calls on that owner', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'struct Worker<T> {}',
          'impl<T> Worker<T> {',
          '  fn run(&self) {',
          '    self.helper();',
          '  }',
          '  fn helper(&self) {}',
          '}',
          'struct Other {}',
          'impl Other {',
          '  fn helper(&self) {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const workerId = result.nodes.find((node) => node.label === 'Worker')?.id
      const otherId = result.nodes.find((node) => node.label === 'Other')?.id
      const workerMethodEdges = result.edges.filter((edge) => edge.source === workerId && edge.relation === 'method')
      const otherMethodEdges = result.edges.filter((edge) => edge.source === otherId && edge.relation === 'method')
      const workerRunId = workerMethodEdges.find((edge) => result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const workerHelperId = workerMethodEdges.find((edge) => result.nodes.find((node) => node.id === edge.target)?.label === '.helper()')?.target
      const otherHelperId = otherMethodEdges.find((edge) => result.nodes.find((node) => node.id === edge.target)?.label === '.helper()')?.target

      expect(workerId).toBeTruthy()
      expect(otherId).toBeTruthy()
      expect(workerMethodEdges).toHaveLength(2)
      expect(workerRunId).toBeTruthy()
      expect(workerHelperId).toBeTruthy()
      expect(otherHelperId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === workerRunId && edge.target === workerHelperId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === workerRunId && edge.target === otherHelperId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts nested rust module ownership without merging same-named types', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const alphaId = result.nodes.find((node) => node.label === 'alpha')?.id
      const betaId = result.nodes.find((node) => node.label === 'beta')?.id
      const workerNodes = result.nodes.filter((node) => node.label === 'Worker')
      const alphaWorkerId = result.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const betaWorkerId = result.edges.find((edge) => edge.source === betaId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const alphaRunId = result.edges.find((edge) => edge.source === alphaWorkerId && edge.relation === 'method')?.target
      const betaRunId = result.edges.find((edge) => edge.source === betaWorkerId && edge.relation === 'method')?.target
      const bootAlphaId = result.nodes.find((node) => node.label === 'boot_alpha()')?.id
      const bootBetaId = result.nodes.find((node) => node.label === 'boot_beta()')?.id

      expect(workerNodes).toHaveLength(2)
      expect(alphaWorkerId).toBeTruthy()
      expect(betaWorkerId).toBeTruthy()
      expect(alphaWorkerId).not.toBe(betaWorkerId)
      expect(alphaRunId).toBeTruthy()
      expect(betaRunId).toBeTruthy()
      expect(alphaRunId).not.toBe(betaRunId)
      expect(result.edges.some((edge) => edge.source === bootAlphaId && edge.target === alphaRunId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bootBetaId && edge.target === betaRunId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bootAlphaId && edge.target === betaRunId && edge.relation === 'calls')).toBe(false)
      expect(result.edges.some((edge) => edge.source === bootBetaId && edge.target === alphaRunId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts grouped rust use imports without adding false prefix import edges', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'mod engine {',
          '  pub struct Foo {}',
          '  pub struct Bar {}',
          '}',
          'use crate::engine::{Foo, Bar};',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const fooId = result.nodes.find((node) => node.label === 'Foo')?.id
      const barId = result.nodes.find((node) => node.label === 'Bar')?.id
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id

      expect(result.edges.some((edge) => edge.source === fileId && edge.target === fooId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === barId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === engineId && edge.relation === 'imports_from')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-namespaced-owner cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 46,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const alphaId = recovered.nodes.find((node) => node.label === 'alpha')?.id
      const betaId = recovered.nodes.find((node) => node.label === 'beta')?.id
      const workerNodes = recovered.nodes.filter((node) => node.label === 'Worker')
      const alphaWorkerId = recovered.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const betaWorkerId = recovered.edges.find((edge) => edge.source === betaId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target

      expect(workerNodes).toHaveLength(2)
      expect(alphaWorkerId).toBeTruthy()
      expect(betaWorkerId).toBeTruthy()
      expect(alphaWorkerId).not.toBe(betaWorkerId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust imports and calls when use declarations appear before the local module owner', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains')?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method')?.target
      const bootId = result.nodes.find((node) => node.label === 'boot()')?.id

      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits nested rust imports_from edges from the importing module instead of the file', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const apiId = result.nodes.find((node) => node.label === 'api')?.id
      const clientId = result.nodes.find((node) => node.label === 'client')?.id
      const workerId = result.edges.find((edge) => edge.source === apiId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = result.edges.find((edge) => edge.source === clientId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(clientId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === clientId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(false)
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-import-order cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 47,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const engineId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const workerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains')?.target

      expect(workerId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts qualified rust impl owners onto the existing namespaced type', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerNodes = result.nodes.filter((node) => node.label === 'Worker')
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method')?.target

      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts qualified rust impl owners before the namespaced type declaration without duplicate owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const workerNodes = result.nodes.filter((node) => node.label === 'Worker')
      const workerId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method')?.target

      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === result.nodes.find((node) => node.label === 'worker.rs')?.id && edge.target === workerId && edge.relation === 'contains')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resolve rust variable receiver calls onto unrelated local types', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'struct Worker {}',
          'impl Worker {',
          '  fn run(&self) {}',
          '}',
          'fn boot(client: ApiClient) {',
          '  client.run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const bootId = result.nodes.find((node) => node.label === 'boot()')?.id
      const runId = result.nodes.find((node) => node.label === '.run()')?.id

      expect(bootId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resolve qualified rust module calls onto unrelated free functions', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const bootId = result.nodes.find((node) => node.label === 'boot()')?.id
      const runId = result.nodes.find((node) => node.label === 'run()')?.id

      expect(bootId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-qualified-impl cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 48,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
          ],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const engineId = recovered.nodes.find((node) => node.label === 'engine')?.id
      const workerNodes = recovered.nodes.filter((node) => node.label === 'Worker')
      const workerId = recovered.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && workerNodes.some((node) => node.id === edge.target))?.target

      expect(workerNodes).toHaveLength(1)
      expect(workerId).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-qualified-ordering cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 50,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: 'run()', file_type: 'code', source_file: filePath },
          ],
          edges: [{ source: 'stale_rust_boot', target: 'stale_rust_run', relation: 'calls' }],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const bootId = recovered.nodes.find((node) => node.label === 'boot()')?.id
      const runId = recovered.nodes.find((node) => node.label === 'run()')?.id

      expect(bootId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust local namespaced type calls inside the current module', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const result = extract([filePath])
      const alphaId = result.nodes.find((node) => node.label === 'alpha')?.id
      const workerId = result.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = result.edges.find((edge) => edge.source === workerId && edge.relation === 'method')?.target
      const bootId = result.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resolve aliased rust use calls onto unrelated local methods', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'mod engine {',
          '  pub struct Worker {}',
          '}',
          'use crate::engine::Worker as Client;',
          'struct Other {}',
          'impl Other {',
          '  fn run(&self) {}',
          '}',
          'fn boot() {',
          '  Client::run();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const bootId = result.nodes.find((node) => node.label === 'boot()')?.id
      const otherRunId = result.edges.find((edge) => edge.relation === 'method' && result.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target

      expect(bootId).toBeTruthy()
      expect(otherRunId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === bootId && edge.target === otherRunId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-local-namespace cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 49,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_alpha', label: 'alpha', file_type: 'code', source_file: filePath },
          ],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const alphaId = recovered.nodes.find((node) => node.label === 'alpha')?.id
      const workerId = recovered.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = recovered.edges.find((edge) => edge.source === workerId && edge.relation === 'method')?.target
      const bootId = recovered.edges.find((edge) => edge.source === alphaId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached rust extractions from the pre-rust-nested-import-scope cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
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

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 58,
          nodes: [
            { id: 'stale_rust_file', label: 'worker.rs', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_api', label: 'api', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_client', label: 'client', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_worker', label: 'Worker', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_boot', label: 'boot()', file_type: 'code', source_file: filePath },
            { id: 'stale_rust_run', label: '.run()', file_type: 'code', source_file: filePath },
          ],
          edges: [
            { source: 'stale_rust_file', target: 'stale_rust_api', relation: 'contains' },
            { source: 'stale_rust_file', target: 'stale_rust_client', relation: 'contains' },
            { source: 'stale_rust_api', target: 'stale_rust_worker', relation: 'contains' },
            { source: 'stale_rust_client', target: 'stale_rust_boot', relation: 'contains' },
            { source: 'stale_rust_file', target: 'stale_rust_worker', relation: 'imports_from' },
          ],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileId = recovered.nodes.find((node) => node.label === 'worker.rs')?.id
      const apiId = recovered.nodes.find((node) => node.label === 'api')?.id
      const clientId = recovered.nodes.find((node) => node.label === 'client')?.id
      const workerId = recovered.edges.find((edge) => edge.source === apiId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const runId = recovered.edges.find((edge) => edge.source === workerId && edge.relation === 'method' && recovered.nodes.find((node) => node.id === edge.target)?.label === '.run()')?.target
      const bootId = recovered.edges.find((edge) => edge.source === clientId && edge.relation === 'contains' && recovered.nodes.find((node) => node.id === edge.target)?.label === 'boot()')?.target

      expect(clientId).toBeTruthy()
      expect(workerId).toBeTruthy()
      expect(runId).toBeTruthy()
      expect(bootId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === clientId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(recovered.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(false)
      expect(recovered.edges.some((edge) => edge.source === bootId && edge.target === runId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts grouped rust use imports with qualified leaves under the outer namespace', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        [
          'mod engine {',
          '  mod nested {',
          '    pub struct Worker {}',
          '  }',
          '  pub struct Bar {}',
          '}',
          'use crate::engine::{nested::Worker, Bar};',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const fileId = result.nodes.find((node) => node.label === 'worker.rs')?.id
      const engineId = result.nodes.find((node) => node.label === 'engine')?.id
      const nestedId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'nested')?.target
      const workerId = result.edges.find((edge) => edge.source === nestedId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Worker')?.target
      const barId = result.edges.find((edge) => edge.source === engineId && edge.relation === 'contains' && result.nodes.find((node) => node.id === edge.target)?.label === 'Bar')?.target

      expect(workerId).toBeTruthy()
      expect(barId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === workerId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === fileId && edge.target === barId && edge.relation === 'imports_from')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts qualified c++ methods under their owner type', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'engine.cpp')
      writeFileSync(
        filePath,
        ['class Engine {', 'public:', '  void start();', '  void stop();', '};', 'void Engine::start() {', '  stop();', '}', 'void Engine::stop() {}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Engine')
      expect(labels).toContain('.start()')
      expect(labels).toContain('.stop()')
      expect(calls.has('.start()->.stop()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts workspace imports onto real shared targets without pulling in unrelated roots', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      const webAppDir = join(root, 'web-app')
      const workerDir = join(root, 'worker')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })
      mkdirSync(webAppDir, { recursive: true })
      mkdirSync(workerDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')
      const sessionPath = join(webAppDir, 'session.ts')
      const jobsPath = join(workerDir, 'jobs.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export class ApiHandler {',
          '  login(userId: string) {',
          '    return createSession(userId)',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        sessionPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        jobsPath,
        [
          'export function reindexWorkspace() {',
          "  return 'queued'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath, sessionPath, jobsPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const sessionFileId = result.nodes.find((node) => node.label === 'session.ts')?.id
      const loginId = result.nodes.find((node) => node.label === '.login()')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const reindexId = result.nodes.find((node) => node.label === 'reindexWorkspace()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(sessionFileId).toBeTruthy()
      expect(loginId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(reindexId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === sessionFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === reindexId && edge.target === createSessionId)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports through a local barrel re-export onto the real shared target', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports through a local imported-binding barrel re-export onto the real shared target', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        indexPath,
        [
          "import { createSession } from './auth.js'",
          'export { createSession }',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports through a local export-star barrel onto the real shared target', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export * from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch explicit-extension js/ts imports onto unrelated source file types', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.cjs'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(false)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers explicit js/ts barrel re-exports over conflicting local export-star sources', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')
      const legacyPath = join(sharedDir, 'legacy.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        indexPath,
        [
          "export { createSession } from './auth.js'",
          "export * from './legacy.js'",
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        legacyPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-legacy-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath, legacyPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const authCreateSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id
      const legacyCreateSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === legacyPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(authCreateSessionId).toBeTruthy()
      expect(legacyCreateSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === authCreateSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === authCreateSessionId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === legacyCreateSessionId && edge.relation === 'imports_from')).toBe(false)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === legacyCreateSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let local export-star barrels backfill unresolved explicit re-export names', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')
      const legacyPath = join(sharedDir, 'legacy.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        indexPath,
        [
          "export { createSession } from './auth.js'",
          "export * from './legacy.js'",
        ].join('\n'),
        'utf8',
      )
      writeFileSync(authPath, 'export const somethingElse = true\n', 'utf8')
      writeFileSync(
        legacyPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-legacy-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath, legacyPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const legacyCreateSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === legacyPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(legacyCreateSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === legacyCreateSessionId && edge.relation === 'imports_from')).toBe(false)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === legacyCreateSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports through local export-star barrel cycles once a real shared target is exported', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const bridgePath = join(sharedDir, 'bridge.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/bridge.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        indexPath,
        [
          "export * from './bridge.js'",
          '',
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(bridgePath, "export * from './index.js'\n", 'utf8')

      const result = extract([apiPath, indexPath, bridgePath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === indexPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports during incremental extraction when the shared target is only present in context nodes', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const unchangedTarget = extract([authPath])
      const result = extract([apiPath], { contextNodes: unchangedTarget.nodes })
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = unchangedTarget.nodes.find((node) => node.label === 'createSession()')?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.nodes.some((node) => node.id === createSessionId)).toBe(false)
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch relative js/ts imports onto non-exported target internals', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { secretHelper } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return secretHelper(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'function secretHelper(userId: string) {',
          '  return `${userId}-secret`',
          '}',
          '',
          'export function createSession(userId: string) {',
          '  return secretHelper(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const secretHelperId = result.nodes.find((node) => node.label === 'secretHelper()')?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(secretHelperId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === secretHelperId && edge.relation === 'imports_from')).toBe(false)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === secretHelperId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when an imported name is shadowed by a local binding', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string, createSession: (id: string) => string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when a same-scope local binding is declared later in the block', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  createSession(userId)',
          '  const createSession = (value: string) => `${value}-local`',
          '  return userId',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when a var binding is hoisted from a nested block', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  if (userId) {',
          '    var createSession = (value: string) => `${value}-local`',
          '  }',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls before a later nested-block var declaration in the same function', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  createSession(userId)',
          '  if (userId) {',
          '    var createSession = (value: string) => `${value}-local`',
          '  }',
          '  return userId',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls before a later var loop-header binding in the same function', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  createSession(userId)',
          '  for (var createSession of [(value: string) => `${value}-local`]) {',
          '    return createSession(userId)',
          '  }',
          '  return userId',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attributes stitched cross-file js/ts calls inside constructors to the constructor method node', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export class ApiHandler {',
          '  constructor(userId: string) {',
          '    createSession(userId)',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiHandlerId = result.nodes.find((node) => node.label === 'ApiHandler')?.id
      const constructorId = result.nodes.find((node) => node.label === '.constructor()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(apiHandlerId).toBeTruthy()
      expect(constructorId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === constructorId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === apiHandlerId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when an inline callback parameter shadows the imported name', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return [(value: string) => `${value}-local`].map((createSession) => createSession(userId)).join(":")',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attributes stitched cross-file js/ts calls to nested helper owners instead of their outer method', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export class ApiHandler {',
          '  login(userId: string) {',
          '    const buildSession = (value: string) => {',
          '      return createSession(value)',
          '    }',
          '    return buildSession(userId)',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const loginId = result.nodes.find((node) => node.label === '.login()')?.id
      const buildSessionId = result.nodes.find((node) => node.label === 'buildSession()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()')?.id

      expect(loginId).toBeTruthy()
      expect(buildSessionId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === buildSessionId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when a named function expression refers to its own local name', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/auth.js'",
          '',
          'export const loginUser = function createSession(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when a loop binding shadows the imported name', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  for (const createSession of [(value: string) => `${value}-local`]) {',
          '    return createSession(userId)',
          '  }',
          '  return userId',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not stitch cross-file js/ts calls when a catch binding shadows the imported name', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import { createSession } from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  try {',
          "    throw (value: string) => `${value}-local`",
          '  } catch (createSession) {',
          '    return createSession(userId)',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { createSession } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()' && node.source_file === authPath)?.id

      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts default imports onto default-exported shared targets', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import createSession from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export default function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()')?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts default imports onto anonymous default-exported shared targets', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import createSession from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export default function (userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = result.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts default imports through a local barrel onto anonymous default-exported shared targets', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import createSession from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(indexPath, "export { default } from './auth.js'\n", 'utf8')
      writeFileSync(
        authPath,
        [
          'export default function (userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = result.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts default imports through a local imported-binding default barrel onto anonymous default-exported shared targets', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const indexPath = join(sharedDir, 'index.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import createSession from '../shared/index.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        indexPath,
        [
          "import createSession from './auth.js'",
          'export default createSession',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export default function (userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, indexPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = result.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts calls from anonymous default-exported shared targets onto imported helpers', () => {
    const root = createTempRoot()
    try {
      const sharedDir = join(root, 'shared')
      mkdirSync(sharedDir, { recursive: true })

      const authPath = join(sharedDir, 'auth.ts')
      const helperPath = join(sharedDir, 'helper.ts')

      writeFileSync(
        authPath,
        [
          "import helper from './helper.js'",
          '',
          'export default function () {',
          '  return helper()',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        helperPath,
        [
          'export default function helper() {',
          "  return 'ready'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([authPath, helperPath])
      const defaultExportId = result.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id
      const helperId = result.nodes.find((node) => node.label === 'helper()' && node.source_file === helperPath)?.id

      expect(defaultExportId).toBeTruthy()
      expect(helperId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === defaultExportId && edge.target === helperId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts imports and calls through parenthesized anonymous default-exported shared targets', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')
      const helperPath = join(sharedDir, 'helper.ts')

      writeFileSync(
        apiPath,
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
        authPath,
        [
          "import helper from './helper.js'",
          '',
          'export default (() => helper())',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        helperPath,
        [
          'export default function helper() {',
          "  return 'ready'",
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath, helperPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const defaultExportId = result.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id
      const helperId = result.nodes.find((node) => node.label === 'helper()' && node.source_file === helperPath)?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(helperId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === defaultExportId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === defaultExportId && edge.relation === 'calls')).toBe(true)
      expect(result.edges.some((edge) => edge.source === defaultExportId && edge.target === helperId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stitches relative js/ts namespace imports onto exported shared members that are actually called', () => {
    const root = createTempRoot()
    try {
      const backendDir = join(root, 'backend')
      const sharedDir = join(root, 'shared')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(sharedDir, { recursive: true })

      const apiPath = join(backendDir, 'api.ts')
      const authPath = join(sharedDir, 'auth.ts')

      writeFileSync(
        apiPath,
        [
          "import * as auth from '../shared/auth.js'",
          '',
          'export function loginUser(userId: string) {',
          '  return auth.createSession(userId)',
          '}',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        authPath,
        [
          'export function createSession(userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([apiPath, authPath])
      const apiFileId = result.nodes.find((node) => node.label === 'api.ts')?.id
      const loginUserId = result.nodes.find((node) => node.label === 'loginUser()')?.id
      const createSessionId = result.nodes.find((node) => node.label === 'createSession()')?.id

      expect(apiFileId).toBeTruthy()
      expect(loginUserId).toBeTruthy()
      expect(createSessionId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === apiFileId && edge.target === createSessionId && edge.relation === 'imports_from')).toBe(true)
      expect(result.edges.some((edge) => edge.source === loginUserId && edge.target === createSessionId && edge.relation === 'calls')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts top-level arrow functions in js or ts files', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'arrow.ts')
      writeFileSync(
        filePath,
        ['const buildHeaders = (token: string) => ({ Authorization: token })', 'const makeHeaders = (token: string) => buildHeaders(token)'].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('buildHeaders()')
      expect(labels).toContain('makeHeaders()')
      expect(calls.has('makeHeaders()->buildHeaders()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts class field arrow methods and their internal calls in js or ts files', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'class-arrow.ts')
      writeFileSync(
        filePath,
        [
          'class HttpClient {',
          '  private buildHeaders = () => ({ Authorization: "Bearer token" })',
          '',
          '  post = async (url: string, data: unknown) => {',
          '    const headers = this.buildHeaders()',
          '    return fetch(url, { method: "POST", headers, body: JSON.stringify(data) })',
          '  }',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('HttpClient')
      expect(labels).toContain('.buildHeaders()')
      expect(labels).toContain('.post()')
      expect(calls.has('.post()->.buildHeaders()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts optional-chaining js or ts method calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'optional-chain.ts')
      writeFileSync(
        filePath,
        ['class Loader {', '  load() {', '    return this?.request?.()', '  }', '', '  request() {', '    return true', '  }', '}'].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(calls.has('.load()->.request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts typescript interface nodes plus extends and implements heritage edges', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'heritage.ts')
      writeFileSync(
        filePath,
        [
          'interface Disposable {',
          '  dispose(): void',
          '}',
          '',
          'class BaseClient {}',
          '',
          'class HttpClient extends BaseClient implements Disposable {',
          '  dispose() {}',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const httpClientId = result.nodes.find((node) => node.label === 'HttpClient')?.id
      const baseClientId = result.nodes.find((node) => node.label === 'BaseClient')?.id
      const disposableId = result.nodes.find((node) => node.label === 'Disposable')?.id

      expect(httpClientId).toBeTruthy()
      expect(baseClientId).toBeTruthy()
      expect(disposableId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === httpClientId && edge.target === baseClientId && edge.relation === 'inherits')).toBe(true)
      expect(result.edges.some((edge) => edge.source === httpClientId && edge.target === disposableId && edge.relation === 'inherits')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts common parser-gap inheritance and signatures for kotlin, scala, and swift', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'worker.kt',
          content: [
            'open class BaseTask',
            'interface Runnable',
            'interface Closeable',
            'class Worker: BaseTask(), Runnable, Closeable {',
            '  fun run(): Int = helper()',
            '  fun helper(): Int { return 1 }',
            '}',
          ].join('\n'),
          ownerLabel: 'Worker',
          inherits: ['BaseTask', 'Runnable', 'Closeable'],
          call: '.run()->.helper()',
        },
        {
          fileName: 'processor.scala',
          content: [
            'trait Logging',
            'trait Serializable',
            'class BaseHandler',
            'class Processor extends BaseHandler with Logging with Serializable {',
            '  def process(): Int = helper()',
            '  def helper(): Int = 1',
            '}',
          ].join('\n'),
          ownerLabel: 'Processor',
          inherits: ['BaseHandler', 'Logging', 'Serializable'],
          call: '.process()->.helper()',
        },
        {
          fileName: 'container.swift',
          content: [
            'protocol Sendable {}',
            'protocol Hashable {}',
            'class BaseCollection {}',
            'final class Container: BaseCollection, Sendable, Hashable {',
            '  func hash() -> Int { return helper() }',
            '  func helper() -> Int { return 0 }',
            '}',
          ].join('\n'),
          ownerLabel: 'Container',
          inherits: ['BaseCollection', 'Sendable', 'Hashable'],
          call: '.hash()->.helper()',
        },
      ]

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(filePath, testCase.content, 'utf8')

        const result = extract([filePath])
        const ownerId = result.nodes.find((node) => node.label === testCase.ownerLabel)?.id
        const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
        const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))
        expect(ownerId).toBeTruthy()
        for (const baseLabel of testCase.inherits) {
          const baseId = result.nodes.find((node) => node.label === baseLabel)?.id
          expect(baseId).toBeTruthy()
          expect(result.edges.some((edge) => edge.source === ownerId && edge.target === baseId && edge.relation === 'inherits')).toBe(true)
        }
        expect(calls.has(testCase.call)).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts multiline scala inheritance and keeps methods owned by the class', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'processor.scala')
      writeFileSync(
        filePath,
        [
          'trait Logging',
          'trait Serializable',
          'class BaseHandler',
          'class Processor extends BaseHandler',
          '  with Logging',
          '  with Serializable {',
          '  def process(): Int = helper()',
          '  def helper(): Int = 1',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const processorId = result.nodes.find((node) => node.label === 'Processor')?.id
      const processId = result.nodes.find((node) => node.label === '.process()')?.id
      const helperId = result.nodes.find((node) => node.label === '.helper()')?.id
      const inherits = result.edges.filter((edge) => edge.source === processorId && edge.relation === 'inherits')
      const containsMethod = result.edges.filter((edge) => edge.source === processorId && edge.relation === 'method').map((edge) => edge.target)

      expect(processorId).toBeTruthy()
      expect(processId).toBeTruthy()
      expect(helperId).toBeTruthy()
      expect(inherits).toHaveLength(3)
      expect(containsMethod).toEqual(expect.arrayContaining([processId, helperId]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits capability-specific provenance for javascript and typescript extraction', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'loader.ts',
          capabilityId: 'builtin:extract:typescript',
          content: ['export class Loader {', '  load() {', '    return helper()', '  }', '}', '', 'function helper() {', '  return true', '}'].join('\n'),
        },
        {
          fileName: 'loader.js',
          capabilityId: 'builtin:extract:javascript',
          content: ['export class Loader {', '  load() {', '    return helper()', '  }', '}', '', 'function helper() {', '  return true', '}'].join('\n'),
        },
      ]

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(filePath, testCase.content, 'utf8')

        const result = extract([filePath])
        const labels = result.nodes.filter((node) => node.source_file === filePath).map((node) => node.label)

        expect(labels).toEqual(expect.arrayContaining([testCase.fileName, 'Loader', '.load()', 'helper()']))
        expect(result.edges.some((edge) => edge.source_file === filePath && edge.relation === 'calls')).toBe(true)
        expectSourceEntriesToUseCapability(result, filePath, testCase.capabilityId)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits raw metadata for go, java, and ruby extraction families', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'client.go',
          capabilityId: 'builtin:extract:go',
          labels: ['client.go', 'Client', '.Get()', '.do()', 'helper()'],
          content: [
            'package main',
            '',
            'type Client struct {}',
            'func (c *Client) Get() error {',
            '  return c.do()',
            '}',
            'func (c *Client) do() error {',
            '  return helper()',
            '}',
            'func helper() error {',
            '  return nil',
            '}',
          ].join('\n'),
        },
        {
          fileName: 'Service.java',
          capabilityId: 'builtin:extract:java',
          labels: ['Service.java', 'Service', '.run()', '.helper()'],
          content: ['class Service {', '  void run() {', '    helper();', '  }', '  void helper() {}', '}'].join('\n'),
        },
        {
          fileName: 'client.rb',
          capabilityId: 'builtin:extract:ruby',
          labels: ['client.rb', 'Client', '.get()', '.request()'],
          content: ['class Client', '  def get', '    request()', '  end', '', '  def request', '  end', 'end'].join('\n'),
        },
      ]

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(filePath, testCase.content, 'utf8')

        const result = extract([filePath])
        const labels = result.nodes.filter((node) => node.source_file === filePath).map((node) => node.label)

        expect(labels).toEqual(expect.arrayContaining(testCase.labels))
        expect(result.edges.some((edge) => edge.source_file === filePath && (edge.relation === 'calls' || edge.relation === 'method'))).toBe(true)
        expectSourceEntriesToUseCapability(result, filePath, testCase.capabilityId)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits raw metadata for lightweight scanner extractors', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'sample.lua',
          capabilityId: 'builtin:extract:lua',
          labels: ['sample.lua', 'Client', '.get()', 'request()'],
          content: ['local Client = {}', '', 'function Client:get()', '  request()', 'end', '', 'function request()', 'end'].join('\n'),
        },
        {
          fileName: 'sample.ex',
          capabilityId: 'builtin:extract:elixir',
          labels: ['sample.ex', 'ApiClient', '.get()', '.request()'],
          content: ['defmodule ApiClient do', '  def get do', '    request()', '  end', '', '  def request do', '  end', 'end'].join('\n'),
        },
        {
          fileName: 'sample.jl',
          capabilityId: 'builtin:extract:julia',
          labels: ['sample.jl', 'Client', 'fetch()', 'normalize()'],
          content: ['struct Client', 'end', '', 'function fetch(client)', '  normalize()', 'end', '', 'function normalize()', 'end'].join('\n'),
        },
        {
          fileName: 'sample.ps1',
          capabilityId: 'builtin:extract:powershell',
          labels: ['sample.ps1', 'ApiClient', '.Get()', 'Invoke-Request()', 'Normalize-Response()'],
          content: [
            'class ApiClient {',
            '  [void] Get() {',
            '    Invoke-Request',
            '  }',
            '}',
            '',
            'function Invoke-Request {',
            '  Normalize-Response',
            '}',
            '',
            'function Normalize-Response {',
            '}',
          ].join('\n'),
        },
        {
          fileName: 'sample.m',
          capabilityId: 'builtin:extract:objective-c',
          labels: ['sample.m', 'Client', '.get()', '.request()'],
          content: [
            '#import <Foundation/Foundation.h>',
            '',
            '@interface Client : NSObject',
            '@end',
            '',
            '@implementation Client',
            '- (void)get {',
            '  [self request];',
            '}',
            '',
            '- (void)request {',
            '}',
            '@end',
          ].join('\n'),
        },
      ]

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(filePath, testCase.content, 'utf8')

        const result = extract([filePath])
        const labels = result.nodes.filter((node) => node.source_file === filePath).map((node) => node.label)

        expect(labels).toEqual(expect.arrayContaining(testCase.labels))
        expect(
          result.edges.some((edge) => edge.source_file === filePath && (edge.relation === 'calls' || edge.relation === 'method' || edge.relation === 'contains')),
        ).toBe(true)
        expectSourceEntriesToUseCapability(result, filePath, testCase.capabilityId)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits capability-specific provenance for generic fallback languages', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'worker.rs',
          capabilityId: 'builtin:extract:rust',
          labels: ['worker.rs', 'Worker', '.run()', '.helper()', 'boot()'],
          content: [
            'struct Worker {}',
            'impl Worker {',
            '  fn run(&self) {',
            '    self.helper();',
            '  }',
            '  fn helper(&self) {}',
            '}',
            'fn boot() {',
            '  Worker::run();',
            '}',
          ].join('\n'),
        },
        {
          fileName: 'worker.kt',
          capabilityId: 'builtin:extract:kotlin',
          labels: ['worker.kt', 'Worker', '.run()', '.helper()'],
          content: ['open class BaseTask', 'class Worker: BaseTask() {', '  fun run(): Int = helper()', '  fun helper(): Int { return 1 }', '}'].join('\n'),
        },
        {
          fileName: 'container.swift',
          capabilityId: 'builtin:extract:swift',
          labels: ['container.swift', 'Container', '.hash()', '.helper()'],
          content: [
            'class BaseCollection {}',
            'final class Container: BaseCollection {',
            '  func hash() -> Int { return helper() }',
            '  func helper() -> Int { return 0 }',
            '}',
          ].join('\n'),
        },
        {
          fileName: 'engine.cpp',
          capabilityId: 'builtin:extract:c-family',
          labels: ['engine.cpp', 'Engine', '.start()', '.stop()'],
          content: ['class Engine {', 'public:', '  void start();', '  void stop();', '};', 'void Engine::start() {', '  stop();', '}', 'void Engine::stop() {}'].join(
            '\n',
          ),
        },
      ]

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(filePath, testCase.content, 'utf8')

        const result = extract([filePath])
        const labels = result.nodes.filter((node) => node.source_file === filePath).map((node) => node.label)

        expect(labels).toEqual(expect.arrayContaining(testCase.labels))
        expect(
          result.edges.some((edge) => edge.source_file === filePath && (edge.relation === 'calls' || edge.relation === 'inherits' || edge.relation === 'method')),
        ).toBe(true)
        expectSourceEntriesToUseCapability(result, filePath, testCase.capabilityId)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts markdown sections and local references for non-code corpora', () => {
    const root = createTempRoot()
    try {
      const readmePath = join(root, 'README.md')
      const guidePath = join(root, 'guide.md')
      const imagePath = join(root, 'diagram.svg')

      writeFileSync(readmePath, '# Overview\nSee [Guide](guide.md)\n![Diagram](diagram.svg)\n## Details\n', 'utf8')
      writeFileSync(guidePath, '# Guide\n', 'utf8')
      writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>', 'utf8')

      const result = extract([readmePath, guidePath, imagePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeByKey = new Map(result.nodes.map((node) => [`${node.file_type}:${node.label}`, node.id]))
      const relations = new Set(result.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`))
      const imageNode = result.nodes.find((node) => node.file_type === 'image' && node.label === 'diagram.svg')
      const referenceEdge = result.edges.find(
        (edge) => edge.source === nodeByKey.get('document:Overview') && edge.target === nodeByKey.get('document:guide.md') && edge.relation === 'references',
      )
      const embedEdge = result.edges.find(
        (edge) => edge.source === nodeByKey.get('document:Overview') && edge.target === nodeByKey.get('image:diagram.svg') && edge.relation === 'embeds',
      )

      expect(labels).toContain('README.md')
      expect(labels).toContain('Overview')
      expect(labels).toContain('Details')
      expect(imageNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:image', stage: 'extract' })],
      })
      expect(relations.has(`${nodeByKey.get('document:README.md')}:contains:${nodeByKey.get('document:Overview')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:references:${nodeByKey.get('document:guide.md')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:embeds:${nodeByKey.get('image:diagram.svg')}`)).toBe(true)
      expect(referenceEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
      })
      expect(embedEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts hidden sidecar metadata onto extracted image file nodes', () => {
    const root = createTempRoot()
    try {
      const imagePath = join(root, 'diagram.png')
      writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]))
      writeFileSync(
        binaryIngestSidecarPath(imagePath),
        JSON.stringify(
          {
            source_url: 'https://example.com/diagram.png',
            captured_at: '2026-04-13T03:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([imagePath])
      const imageNode = result.nodes.find((node) => node.file_type === 'image' && node.label === 'diagram.png')

      expect(imageNode).toMatchObject({
        source_url: 'https://example.com/diagram.png',
        captured_at: '2026-04-13T03:00:00Z',
        contributor: 'sadeem',
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:image', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:image',
            stage: 'ingest',
            source_url: 'https://example.com/diagram.png',
            captured_at: '2026-04-13T03:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(imageNode?.provenance).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts hidden sidecar metadata onto extracted pdf file nodes without disturbing pdf heuristics', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Title (Sadeem Paper) /Subject (Runtime Notes) >>\nstream\n(Abstract) Tj\nendstream\nendobj\n'
      writeFileSync(paperPath, pdfContent, 'latin1')
      writeFileSync(
        binaryIngestSidecarPath(paperPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/paper.pdf',
            captured_at: '2026-04-13T04:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([paperPath])
      const paperNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'paper.pdf')
      const titleNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Sadeem Paper')
      const containsEdges = result.edges.filter((edge) => edge.source_file === paperPath && edge.relation === 'contains')

      expect(paperNode).toMatchObject({
        title: 'Sadeem Paper',
        subject: 'Runtime Notes',
        source_url: 'https://example.com/paper.pdf',
        captured_at: '2026-04-13T04:00:00Z',
        contributor: 'sadeem',
        content_type: 'application/pdf',
        file_bytes: Buffer.byteLength(pdfContent, 'latin1'),
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:pdf',
            stage: 'ingest',
            source_url: 'https://example.com/paper.pdf',
            captured_at: '2026-04-13T04:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(titleNode).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:pdf', stage: 'ingest' }),
        ]),
      })
      expect(paperNode?.provenance).toHaveLength(2)
      expect(titleNode?.provenance).toHaveLength(2)
      expect(containsEdges.length).toBeGreaterThan(0)
      expect(containsEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length === 2)).toBe(true)
      for (const edge of containsEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: expect.arrayContaining([
            expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' }),
            expect.objectContaining({ capability_id: 'builtin:ingest:pdf', stage: 'ingest' }),
          ]),
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts local audio and video files as metadata-aware file nodes', () => {
    const root = createTempRoot()
    try {
      const audioPath = join(root, 'episode.mp3')
      const videoPath = join(root, 'demo.mp4')
      writeFileSync(audioPath, Buffer.from('ID3'))
      writeFileSync(videoPath, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
      writeFileSync(
        binaryIngestSidecarPath(audioPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T01:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )
      writeFileSync(
        binaryIngestSidecarPath(videoPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/sessions/demo',
            captured_at: '2026-04-14T01:05:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([audioPath, videoPath])
      const audioNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.mp3')
      const videoNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'demo.mp4')

      expect(audioNode).toMatchObject({
        source_url: 'https://example.com/podcast/episodes/1',
        captured_at: '2026-04-14T01:00:00Z',
        contributor: 'sadeem',
        content_type: 'audio/mpeg',
        file_bytes: 3,
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T01:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(videoNode).toMatchObject({
        source_url: 'https://example.com/sessions/demo',
        captured_at: '2026-04-14T01:05:00Z',
        contributor: 'sadeem',
        content_type: 'video/mp4',
        file_bytes: 8,
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/sessions/demo',
            captured_at: '2026-04-14T01:05:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(audioNode?.provenance).toHaveLength(2)
      expect(videoNode?.provenance).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts deterministic duration metadata for wav and mp4 media assets', () => {
    const root = createTempRoot()
    try {
      const wavPath = join(root, 'tone.wav')
      const mp4Path = join(root, 'clip.mp4')
      const wavBuffer = createTestWavBuffer(1.5)
      const mp4Buffer = createTestMp4Buffer(2.5)
      writeFileSync(wavPath, wavBuffer)
      writeFileSync(mp4Path, mp4Buffer)

      const result = extract([wavPath, mp4Path])
      const wavNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'tone.wav')
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.mp4')

      expect(wavNode).toMatchObject({
        content_type: 'audio/wav',
        file_bytes: wavBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 4000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts deterministic MP3 track metadata from ID3 tags', () => {
    const root = createTempRoot()
    try {
      const mp3Path = join(root, 'episode.mp3')
      const mp3Buffer = createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(mp3Path, mp3Buffer)

      const result = extract([mp3Path])
      const mp3Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.mp3')

      expect(mp3Node).toMatchObject({
        content_type: 'audio/mpeg',
        file_bytes: mp3Buffer.length,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts MP3 track metadata from ID3 tags with v2.3 and v2.4 extended headers', () => {
    const root = createTempRoot()
    try {
      const v23Path = join(root, 'episode-v23.mp3')
      const v24Path = join(root, 'episode-v24.mp3')
      writeFileSync(v23Path, createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { version: 3, extendedHeader: true }))
      writeFileSync(v24Path, createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { version: 4, extendedHeader: true }))

      const result = extract([v23Path, v24Path])
      const v23Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode-v23.mp3')
      const v24Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode-v24.mp3')

      expect(v23Node).toMatchObject({
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
      expect(v24Node).toMatchObject({
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits MP3 tag metadata when a UTF-16 ID3 text frame is malformed', () => {
    const root = createTempRoot()
    try {
      const mp3Path = join(root, 'broken-id3.mp3')
      const mp3Buffer = createMalformedUtf16Mp3Buffer()
      writeFileSync(mp3Path, mp3Buffer)

      const result = extract([mp3Path])
      const mp3Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'broken-id3.mp3')

      expect(mp3Node).toMatchObject({
        content_type: 'audio/mpeg',
        file_bytes: mp3Buffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(mp3Node?.audio_title).toBeUndefined()
      expect(mp3Node?.audio_artist).toBeUndefined()
      expect(mp3Node?.audio_album).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits MP3 tag metadata when a v2.4 synchsafe size field is malformed', () => {
    const root = createTempRoot()
    try {
      const mp3Path = join(root, 'broken-size-id3.mp3')
      const mp3Buffer = createMalformedV24SynchsafeSizeMp3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(mp3Path, mp3Buffer)

      const result = extract([mp3Path])
      const mp3Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'broken-size-id3.mp3')

      expect(mp3Node).toMatchObject({
        content_type: 'audio/mpeg',
        file_bytes: mp3Buffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(mp3Node?.audio_title).toBeUndefined()
      expect(mp3Node?.audio_artist).toBeUndefined()
      expect(mp3Node?.audio_album).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts MP3 track metadata even when later ID3 frames make the overall tag large', () => {
    const root = createTempRoot()
    try {
      const mp3Path = join(root, 'large-id3.mp3')
      const mp3Buffer = createLargeMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(mp3Path, mp3Buffer)

      const result = extract([mp3Path])
      const mp3Node = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'large-id3.mp3')

      expect(mp3Node).toMatchObject({
        content_type: 'audio/mpeg',
        file_bytes: mp3Buffer.length,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts deterministic FLAC and Ogg-family metadata from saved audio assets', () => {
    const root = createTempRoot()
    try {
      const flacPath = join(root, 'episode.flac')
      const oggPath = join(root, 'episode.ogg')
      const opusPath = join(root, 'episode.opus')
      const flacBuffer = createTestFlacBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      const oggBuffer = createTestOggVorbisBuffer({
        title: 'Release Notes',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      const opusBuffer = createTestOggOpusBuffer({
        title: 'Voice Memo',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(flacPath, flacBuffer)
      writeFileSync(oggPath, oggBuffer)
      writeFileSync(opusPath, opusBuffer)

      const result = extract([flacPath, oggPath, opusPath])
      const flacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.flac')
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.ogg')
      const opusNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.opus')

      expect(flacNode).toMatchObject({
        content_type: 'audio/flac',
        file_bytes: flacBuffer.length,
        media_duration_seconds: 3.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        file_bytes: oggBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(opusNode).toMatchObject({
        content_type: 'audio/opus',
        file_bytes: opusBuffer.length,
        media_duration_seconds: 1.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 1,
        audio_title: 'Voice Memo',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Ogg Vorbis metadata when a non-audio BOS stream appears before the target stream', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'prefixed.ogg')
      const oggBuffer = Buffer.concat([
        createOggSkeletonBosPage(),
        ...createOggVorbisStreamPages({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(oggPath, oggBuffer)

      const result = extract([oggPath])
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'prefixed.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        file_bytes: oggBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Opus metadata when a non-audio BOS stream appears before the target stream', () => {
    const root = createTempRoot()
    try {
      const opusPath = join(root, 'prefixed.opus')
      const opusBuffer = Buffer.concat([
        createOggSkeletonBosPage(),
        createTestOggOpusBuffer({
          title: 'Voice Memo',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(opusPath, opusBuffer)

      const result = extract([opusPath])
      const opusNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'prefixed.opus')

      expect(opusNode).toMatchObject({
        content_type: 'audio/opus',
        file_bytes: opusBuffer.length,
        media_duration_seconds: 1.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 1,
        audio_title: 'Voice Memo',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Ogg Vorbis metadata when a large prefixed non-audio stream pushes the target BOS page beyond the default head window', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'large-prefixed.ogg')
      const oggBuffer = Buffer.concat([
        ...createOggFillerPages(300_000, 29),
        ...createOggVorbisStreamPages({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(oggPath, oggBuffer)

      const result = extract([oggPath])
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'large-prefixed.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        file_bytes: oggBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Opus metadata when a large prefixed non-audio stream pushes the target BOS page beyond the default head window', () => {
    const root = createTempRoot()
    try {
      const opusPath = join(root, 'large-prefixed.opus')
      const opusBuffer = Buffer.concat([
        ...createOggFillerPages(300_000, 29),
        createTestOggOpusBuffer({
          title: 'Voice Memo',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(opusPath, opusBuffer)

      const result = extract([opusPath])
      const opusNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'large-prefixed.opus')

      expect(opusNode).toMatchObject({
        content_type: 'audio/opus',
        file_bytes: opusBuffer.length,
        media_duration_seconds: 1.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 1,
        audio_title: 'Voice Memo',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts deterministic AAC and M4A metadata from saved audio assets', () => {
    const root = createTempRoot()
    try {
      const aacPath = join(root, 'tone.aac')
      const m4aPath = join(root, 'episode.m4a')
      const aacBuffer = createTestAacBuffer()
      const m4aBuffer = createTestM4aBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(aacPath, aacBuffer)
      writeFileSync(m4aPath, m4aBuffer)

      const result = extract([aacPath, m4aPath])
      const aacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'tone.aac')
      const m4aNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.m4a')

      expect(aacNode).toMatchObject({
        content_type: 'audio/aac',
        file_bytes: aacBuffer.length,
        media_duration_seconds: 1.6,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(m4aNode).toMatchObject({
        content_type: 'audio/mp4',
        file_bytes: m4aBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits AAC duration metadata when the final ADTS frame is truncated', () => {
    const root = createTempRoot()
    try {
      const aacPath = join(root, 'truncated.aac')
      const aacBuffer = createTestAacBuffer().subarray(0, createTestAacBuffer().length - 3)
      writeFileSync(aacPath, aacBuffer)

      const result = extract([aacPath])
      const aacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'truncated.aac')

      expect(aacNode).toMatchObject({
        content_type: 'audio/aac',
        file_bytes: aacBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(aacNode?.media_duration_seconds).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts AAC duration metadata using the ADTS raw block count', () => {
    const root = createTempRoot()
    try {
      const aacPath = join(root, 'multiblock.aac')
      const aacBuffer = createTestAacBuffer(20, 48_000, 2, 8, 3)
      writeFileSync(aacPath, aacBuffer)

      const result = extract([aacPath])
      const aacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'multiblock.aac')

      expect(aacNode).toMatchObject({
        content_type: 'audio/aac',
        file_bytes: aacBuffer.length,
        media_duration_seconds: 1.28,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits M4A track metadata when the ilst data box is truncated', () => {
    const root = createTempRoot()
    try {
      const m4aPath = join(root, 'broken-tags.m4a')
      const m4aBuffer = createTestM4aBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { truncateMetadata: true })
      writeFileSync(m4aPath, m4aBuffer)

      const result = extract([m4aPath])
      const m4aNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'broken-tags.m4a')

      expect(m4aNode).toMatchObject({
        content_type: 'audio/mp4',
        file_bytes: m4aBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(m4aNode?.audio_title).toBeUndefined()
      expect(m4aNode?.audio_artist).toBeUndefined()
      expect(m4aNode?.audio_album).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts deterministic MP4-family, AVI, and Matroska/WebM video metadata from saved assets, including large AVI files', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'clip.mp4')
      const aviPath = join(root, 'recording.avi')
      const webmPath = join(root, 'session.webm')
      const mkvPath = join(root, 'archive.mkv')
      const mp4Buffer = createTestVideoMp4Buffer()
      const aviBuffer = createTestAviBuffer({
        zeroMainHeaderDuration: true,
        zeroMainHeaderDimensions: true,
        tailPaddingBytes: 300_000,
      })
      const webmBuffer = createTestMatroskaBuffer()
      const mkvBuffer = createTestMatroskaBuffer({ docType: 'matroska', durationSeconds: 6.75, width: 854, height: 480 })
      writeFileSync(mp4Path, mp4Buffer)
      writeFileSync(aviPath, aviBuffer)
      writeFileSync(webmPath, webmBuffer)
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mp4Path, aviPath, webmPath, mkvPath])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.mp4')
      const aviNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'recording.avi')
      const webmNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'session.webm')
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'archive.mkv')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(aviNode).toMatchObject({
        content_type: 'video/x-msvideo',
        file_bytes: aviBuffer.length,
        media_duration_seconds: 3.5,
        video_width_px: 640,
        video_height_px: 360,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 6.75,
        video_width_px: 854,
        video_height_px: 480,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts embedded audio-track metadata from Matroska/WebM video assets when the video track appears before the audio track', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'session.webm')
      const webmBuffer = createTestMatroskaBuffer({ audioTrackFirst: false, includeAudioTrackMetadata: true })
      writeFileSync(webmPath, webmBuffer)

      const result = extract([webmPath])
      const webmNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'session.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when a large prefixed segment element pushes Info and Tracks beyond the default head window', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'windowed-session.webm')
      const webmBuffer = createTestMatroskaBuffer({
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 300_000,
      })
      writeFileSync(webmPath, webmBuffer)

      const result = extract([webmPath])
      const webmNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'windowed-session.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata via SeekHead when Info and Tracks sit beyond the widened head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-windowed.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-windowed.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when later top-level Info and Tracks sit beyond the widened head window without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-windowed.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-windowed.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata when a later top-level Tracks element is video-only without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata when a later top-level Tracks element is audio-only without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-clear-video.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-clear-video.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps Matroska/WebM track metadata when a later authoritative Tracks element is unreadable', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-unreadable.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-unreadable.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps Matroska/WebM track metadata when a later top-level Tracks element is unreadable without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-unreadable.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-unreadable.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata when a later top-level Tracks element is video-only and bounded by a trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-trailing-child-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata when a later top-level Tracks element is audio-only and bounded by a trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-trailing-child-clear-video.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-clear-video.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM track metadata when a later top-level Tracks element is corrected and bounded by a trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-trailing-child-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM track metadata when a later top-level Tracks element is followed by an overrun trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-trailing-child-overrun-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM track metadata when a later top-level Tracks element is followed by a truncated trailing child header without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-tracks-trailing-child-truncated-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-tracks-trailing-child-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration metadata when a later top-level Info element omits duration without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-clear-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration metadata when a later top-level Info element omits duration before a trailing child at the exact Info boundary without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-clear-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration before a trailing child at the exact Info boundary without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-invalid-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration followed by an overrun trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-invalid-overrun-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration metadata when a later top-level Info element omits duration and is followed by an overrun trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-omitted-overrun-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-omitted-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration metadata when a later top-level Info element omits duration and is followed by a truncated trailing child header without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-omitted-truncated-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-omitted-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration metadata when a later top-level Info element has malformed Duration followed by a truncated trailing child header without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-invalid-truncated-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-invalid-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM duration metadata when a later top-level Info element is corrected and bounded by a trailing child without SeekHead help', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-info-trailing-child-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-info-trailing-child-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps Matroska/WebM duration when a later SeekHead Info target is unreadable', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-unreadable-info.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        useSeekHead: true,
        invalidTrailingInfoSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-unreadable-info.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM duration via SeekHead when the Info element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-info-partial.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        prefixedInfoBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-info-partial.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM duration without SeekHead when the direct Info element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-partial.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        prefixedInfoBytes: 600_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-partial.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM duration without SeekHead when a direct Info target with parseable duration is followed by a trailing child at the exact Info boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration without SeekHead when a later direct Info target is unreadable on bounded reread', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-unreadable-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        prefixedInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-unreadable-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM track metadata via SeekHead when the Tracks element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-partial.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedTracksBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-partial.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM track metadata without SeekHead when the direct Tracks element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-partial.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedTracksBytes: 600_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-partial.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-padding.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        trailingTracksBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        trailingTracksChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM duration metadata without SeekHead when the later direct Info element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-corrective.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        prefixedInfoBytes: 600_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding-corrective.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM duration from a direct Info target without SeekHead when corrected duration is followed by a trailing child at the exact Info boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-corrective.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration from a direct Info prefix without SeekHead when the remaining Info payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding-clear-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is omitted before trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding-omit-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-omit-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is omitted before a trailing metadata child beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-omit-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-omit-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration from a direct Info prefix without SeekHead when Duration is malformed before a trailing metadata child beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-invalid-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration from a direct Info prefix without SeekHead when malformed Duration is followed by an overrun trailing metadata child', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-invalid-overrun-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration from a direct Info prefix without SeekHead when malformed Duration is followed by a truncated trailing metadata child header', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-invalid-truncated-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration from a direct Info prefix without SeekHead when an omitted-Duration trailing metadata child overruns the Info boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-overrun-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM duration from a direct Info prefix without SeekHead when an omitted-Duration trailing metadata child header is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-omitted-truncated-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-omitted-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM track metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-padding-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces stale Matroska/WebM track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM track metadata without SeekHead when a later direct Tracks target is unreadable on bounded reread', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-unreadable-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-unreadable-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        video_width_px: 5,
        video_height_px: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-padding-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata from a direct Tracks prefix without SeekHead when the remaining Tracks payload is trailing padding beyond the head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-padding-clear-dimensions.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-clear-dimensions.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata from a direct Tracks prefix without SeekHead when a trailing child reaches the exact Tracks boundary', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-clear-dimensions.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-clear-dimensions.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when separate SeekHeads advertise Info and Tracks beyond the widened head window', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-split.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
        splitSeekHeads: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-split.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when a later SeekHead corrects a stale first Tracks target', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-fallback.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
        staleFirstTracksSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-fallback.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when a later SeekHead overrides stale direct Tracks metadata', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Matroska/WebM metadata when a later SeekHead overrides stale direct Info metadata', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-info-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-info-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata when a later authoritative Tracks element is video-only', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration metadata without SeekHead when the later direct Info element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-clear-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM audio-track metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata without SeekHead when the later direct Tracks element starts inside the head window but its payload is truncated', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-clear-dimensions.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-clear-dimensions.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM track metadata without SeekHead when a later direct Tracks prefix is followed by a truncated trailing child header', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-truncated-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stale Matroska/WebM track metadata without SeekHead when a later direct Tracks prefix is followed by an overrun trailing child', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-overrun-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM video-dimension metadata when a later authoritative Tracks element is audio-only', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-clear-video.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-clear-video.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('video_width_px')
      expect(mkvNode).not.toHaveProperty('video_height_px')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears stale Matroska/WebM duration metadata when a later authoritative Info element omits duration', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-info-clear-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const result = extract([mkvPath])
      const mkvNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-info-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts embedded audio-track metadata from AVI video assets when the video stream appears before the audio stream', () => {
    const root = createTempRoot()
    try {
      const aviPath = join(root, 'clip.avi')
      const aviBuffer = createTestAviBuffer({ audioTrackFirst: false })
      writeFileSync(aviPath, aviBuffer)

      const result = extract([aviPath])
      const aviNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.avi')

      expect(aviNode).toMatchObject({
        content_type: 'video/x-msvideo',
        file_bytes: aviBuffer.length,
        media_duration_seconds: 3.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 640,
        video_height_px: 360,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts embedded audio-track metadata from MP4-family video assets when the video track appears before the audio track', () => {
    const root = createTempRoot()
    try {
      const movPath = join(root, 'clip.mov')
      const movBuffer = createTestVideoMp4Buffer({ audioTrackFirst: false })
      writeFileSync(movPath, movBuffer)

      const result = extract([movPath])
      const movNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.mov')

      expect(movNode).toMatchObject({
        content_type: 'video/quicktime',
        file_bytes: movBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits AVI resolution metadata when the video format chunk is truncated', () => {
    const root = createTempRoot()
    try {
      const aviPath = join(root, 'broken-video.avi')
      const aviBuffer = createTestAviBuffer({ zeroMainHeaderDimensions: true, truncateVideoFormat: true })
      writeFileSync(aviPath, aviBuffer)

      const result = extract([aviPath])
      const aviNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'broken-video.avi')

      expect(aviNode).toMatchObject({
        content_type: 'video/x-msvideo',
        file_bytes: aviBuffer.length,
        media_duration_seconds: 3.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(aviNode?.video_width_px).toBeUndefined()
      expect(aviNode?.video_height_px).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits MP4-family video resolution metadata when the visual sample entry is truncated', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'broken-video.mp4')
      const mp4Buffer = createTestVideoMp4Buffer({ truncateVideoSampleEntry: true })
      writeFileSync(mp4Path, mp4Buffer)

      const result = extract([mp4Path])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'broken-video.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mp4Node?.video_width_px).toBeUndefined()
      expect(mp4Node?.video_height_px).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to tkhd dimensions when the MP4-family visual sample entry is truncated', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'tkhd-fallback.mp4')
      const mp4Buffer = createTestVideoMp4Buffer({ truncateVideoSampleEntry: true, includeVideoTkhdDimensions: true })
      writeFileSync(mp4Path, mp4Buffer)

      const result = extract([mp4Path])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'tkhd-fallback.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to mdhd duration for MP4-family audio assets when mvhd is absent', () => {
    const root = createTempRoot()
    try {
      const m4aPath = join(root, 'track.m4a')
      const m4aBuffer = createTestM4aBuffer(
        { title: 'Fallback Song', artist: 'Sadeem FM', album: 'Parity' },
        { omitMovieHeaderDuration: true, includeTrackMdhdDuration: true },
      )
      writeFileSync(m4aPath, m4aBuffer)

      const result = extract([m4aPath])
      const m4aNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'track.m4a')

      expect(m4aNode).toMatchObject({
        content_type: 'audio/mp4',
        file_bytes: m4aBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Fallback Song',
        audio_artist: 'Sadeem FM',
        audio_album: 'Parity',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to mdhd duration for MP4-family video assets when mvhd is absent', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'mdhd-fallback.mp4')
      const mp4Buffer = createTestVideoMp4Buffer({ omitMovieHeaderDuration: true, includeTrackMdhdDuration: true })
      writeFileSync(mp4Path, mp4Buffer)

      const result = extract([mp4Path])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'mdhd-fallback.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits Matroska/WebM duration metadata when the Duration element is malformed', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'broken-duration.webm')
      const webmBuffer = createTestMatroskaBuffer({ malformedDuration: true })
      writeFileSync(webmPath, webmBuffer)

      const result = extract([webmPath])
      const webmNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'broken-duration.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(webmNode?.media_duration_seconds).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits Matroska/WebM duration metadata when the TimecodeScale element is zero', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'zero-scale.webm')
      const webmBuffer = createTestMatroskaBuffer({ timecodeScale: 0 })
      writeFileSync(webmPath, webmBuffer)

      const result = extract([webmPath])
      const webmNode = result.nodes.find((node) => node.file_type === 'video' && node.label === 'zero-scale.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(webmNode?.media_duration_seconds).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the matching logical stream when deriving Ogg duration metadata', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'chained.ogg')
      const oggBuffer = Buffer.concat([
        createTestOggVorbisBuffer({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }, { durationSeconds: 2.5, bitstreamSerialNumber: 17 }),
        createTestOggVorbisBuffer({
          title: 'Other Stream',
          artist: 'Fallback FM',
          album: 'Ignored Album',
        }, { durationSeconds: 7.25, bitstreamSerialNumber: 29 }),
      ])
      writeFileSync(oggPath, oggBuffer)

      const result = extract([oggPath])
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'chained.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts Ogg track metadata even when non-target stream pages are interleaved before the comment packet', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'interleaved.ogg')
      const targetPages = createOggVorbisStreamPages({
        title: 'Release Notes',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { bitstreamSerialNumber: 17 })
      const targetIdPage = targetPages[0]!
      const targetCommentPage = targetPages[1]!
      const targetTerminalPage = targetPages[2]!
      const interleavedOtherPage = createOggPage(Buffer.alloc(48, 0), {
        headerType: 0x02,
        granulePosition: 0n,
        bitstreamSerialNumber: 29,
        sequenceNumber: 0,
      })
      const oggBuffer = Buffer.concat([
        targetIdPage,
        interleavedOtherPage,
        targetCommentPage,
        targetTerminalPage,
      ])
      writeFileSync(oggPath, oggBuffer)

      const result = extract([oggPath])
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'interleaved.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds the target Ogg duration even when later streams push it outside the last scan window', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'far-tail.ogg')
      const oggBuffer = Buffer.concat([
        createTestOggVorbisBuffer({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }, { durationSeconds: 2.5, bitstreamSerialNumber: 17 }),
        ...createOggFillerPages(300_000, 29),
      ])
      writeFileSync(oggPath, oggBuffer)

      const result = extract([oggPath])
      const oggNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'far-tail.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports Opus audio_sample_rate_hz as the fixed decode rate', () => {
    const root = createTempRoot()
    try {
      const opusPath = join(root, 'voice-16k.opus')
      const opusBuffer = createTestOggOpusBuffer({
        title: 'Voice Memo',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { inputSampleRate: 16_000 })
      writeFileSync(opusPath, opusBuffer)

      const result = extract([opusPath])
      const opusNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'voice-16k.opus')

      expect(opusNode).toMatchObject({
        content_type: 'audio/opus',
        media_duration_seconds: 1.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 1,
        audio_title: 'Voice Memo',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts FLAC track metadata even when a large metadata block appears before Vorbis comments', () => {
    const root = createTempRoot()
    try {
      const flacPath = join(root, 'large-padding.flac')
      const flacBuffer = createTestFlacBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { leadingPaddingBytes: 300_000 })
      writeFileSync(flacPath, flacBuffer)

      const result = extract([flacPath])
      const flacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'large-padding.flac')

      expect(flacNode).toMatchObject({
        content_type: 'audio/flac',
        media_duration_seconds: 3.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits FLAC track metadata when the Vorbis comment block is truncated', () => {
    const root = createTempRoot()
    try {
      const flacPath = join(root, 'broken-comments.flac')
      const flacBuffer = createTestFlacBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      }, { truncateCommentBlock: true })
      writeFileSync(flacPath, flacBuffer)

      const result = extract([flacPath])
      const flacNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'broken-comments.flac')

      expect(flacNode).toMatchObject({
        content_type: 'audio/flac',
        file_bytes: flacBuffer.length,
        media_duration_seconds: 3.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(flacNode?.audio_title).toBeUndefined()
      expect(flacNode?.audio_artist).toBeUndefined()
      expect(flacNode?.audio_album).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits wav duration metadata when the declared data chunk is truncated', () => {
    const root = createTempRoot()
    try {
      const wavPath = join(root, 'truncated.wav')
      const truncatedHeaderOnlyBuffer = createTestWavBuffer(3).subarray(0, 44)
      writeFileSync(wavPath, truncatedHeaderOnlyBuffer)

      const result = extract([wavPath])
      const wavNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'truncated.wav')

      expect(wavNode).toMatchObject({
        content_type: 'audio/wav',
        file_bytes: truncatedHeaderOnlyBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(wavNode?.media_duration_seconds).toBeUndefined()
      expect(wavNode?.audio_sample_rate_hz).toBeUndefined()
      expect(wavNode?.audio_channel_count).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits wav metadata when the fmt chunk is too short to describe the stream', () => {
    const root = createTempRoot()
    try {
      const wavPath = join(root, 'short-fmt.wav')
      const malformedBuffer = createMalformedShortFmtWavBuffer()
      writeFileSync(wavPath, malformedBuffer)

      const result = extract([wavPath])
      const wavNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'short-fmt.wav')

      expect(wavNode).toMatchObject({
        content_type: 'audio/wav',
        file_bytes: malformedBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(wavNode?.media_duration_seconds).toBeUndefined()
      expect(wavNode?.audio_sample_rate_hz).toBeUndefined()
      expect(wavNode?.audio_channel_count).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits mp4 duration metadata when mvhd-like bytes are not inside a real moov atom', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'fake-duration.mp4')
      const fakeMp4Buffer = createFakeMvhdTaggedMp4Buffer(9.25)
      writeFileSync(mp4Path, fakeMp4Buffer)

      const result = extract([mp4Path])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'fake-duration.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: fakeMp4Buffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mp4Node?.media_duration_seconds).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits mp4 duration metadata when fake moov bytes only appear inside mdat payload data', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'tail-fake-duration.mp4')
      const fakeMp4Buffer = createLargeFakeTailTaggedMp4Buffer(12.75)
      writeFileSync(mp4Path, fakeMp4Buffer)

      const result = extract([mp4Path])
      const mp4Node = result.nodes.find((node) => node.file_type === 'video' && node.label === 'tail-fake-duration.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: fakeMp4Buffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mp4Node?.media_duration_seconds).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps binary extraction resilient when a detected media asset disappears before extraction', () => {
    const root = createTempRoot()
    try {
      const audioPath = join(root, 'episode.mp3')
      writeFileSync(audioPath, Buffer.from('ID3'))
      rmSync(audioPath)

      const result = extract([audioPath])
      const audioNode = result.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.mp3')

      expect(audioNode).toMatchObject({
        label: 'episode.mp3',
        content_type: 'audio/mpeg',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
      expect(audioNode?.file_bytes).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores malformed hidden sidecar metadata for binary extraction', () => {
    const root = createTempRoot()
    try {
      const imagePath = join(root, 'broken.png')
      writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]))
      writeFileSync(binaryIngestSidecarPath(imagePath), '{not-json', 'utf8')

      const result = extract([imagePath])
      const imageNode = result.nodes.find((node) => node.file_type === 'image' && node.label === 'broken.png')

      expect(imageNode).toMatchObject({
        label: 'broken.png',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:image', stage: 'extract' })],
      })
      expect(imageNode?.source_url).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts markdown frontmatter metadata and resolves source_nodes into references', () => {
    const root = createTempRoot()
    try {
      const authPath = join(root, 'auth.ts')
      const clientPath = join(root, 'client.ts')
      const notePath = join(root, 'notes.md')
      writeFileSync(authPath, 'export function authenticate() {\n  return true\n}\n', 'utf8')
      writeFileSync(clientPath, 'export function requestToken() {\n  return authenticate()\n}\n', 'utf8')
      writeFileSync(
        notePath,
        [
          '---',
          'title: "Auth notebook"',
          'source_url: "https://example.com/auth"',
          'captured_at: "2026-04-11T00:00:00Z"',
          'author: "Jane Doe"',
          'contributor: "copilot"',
          'source_nodes: ["authenticate()", "requestToken()"]',
          '---',
          '',
          '# Notes',
          '',
          'See the linked source nodes for the full auth flow.',
        ].join('\n'),
        'utf8',
      )

      const result = extract([authPath, clientPath, notePath])
      const noteNode = result.nodes.find((node) => node.label === 'notes.md')
      const authenticateId = result.nodes.find((node) => node.label === 'authenticate()')?.id
      const requestTokenId = result.nodes.find((node) => node.label === 'requestToken()')?.id
      const referenceEdges = result.edges.filter((edge) => edge.source === noteNode?.id && edge.relation === 'references')

      expect(noteNode).toMatchObject({
        title: 'Auth notebook',
        source_url: 'https://example.com/auth',
        captured_at: '2026-04-11T00:00:00Z',
        author: 'Jane Doe',
        contributor: 'copilot',
      })
      expect(Array.isArray(noteNode?.source_nodes)).toBe(true)
      expect(result.edges.some((edge) => edge.source === noteNode?.id && edge.target === authenticateId && edge.relation === 'references')).toBe(true)
      expect(result.edges.some((edge) => edge.source === noteNode?.id && edge.target === requestTokenId && edge.relation === 'references')).toBe(true)
      expect(referenceEdges).toHaveLength(2)
      expect(referenceEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(referenceEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const edge of referenceEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits explicit base-layer provenance on frontmatter-enriched markdown extraction before normalization', () => {
    const root = createTempRoot()
    try {
      const guidePath = join(root, 'guide.md')
      const appendixPath = join(root, 'appendix.md')
      writeFileSync(appendixPath, '# Appendix\n', 'utf8')
      writeFileSync(
        guidePath,
        [
          '---',
          'title: "Guide"',
          'layer: "semantic"',
          'provenance: "spoofed"',
          'source_url: "https://example.com/guide"',
          'captured_at: "2026-04-13T00:00:00Z"',
          'author: "Docs Team"',
          'contributor: "sadeem"',
          '---',
          '',
          '# Guide',
          '',
          'See [Appendix](appendix.md).',
        ].join('\n'),
        'utf8',
      )

      const result = extract([guidePath, appendixPath])
      const fileNode = result.nodes.find((node) => node.label === 'guide.md')
      const headingNode = result.nodes.find((node) => node.label === 'Guide' && node.source_file === guidePath)
      const referenceEdge = result.edges.find((edge) => edge.source_file === guidePath && edge.relation === 'references')

      expect(fileNode).toMatchObject({
        layer: 'base',
        source_url: 'https://example.com/guide',
        captured_at: '2026-04-13T00:00:00Z',
        author: 'Docs Team',
        contributor: 'sadeem',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/guide',
            captured_at: '2026-04-13T00:00:00Z',
            author: 'Docs Team',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(headingNode).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(referenceEdge).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(fileNode?.provenance).toHaveLength(2)
      expect(headingNode?.provenance).toHaveLength(2)
      expect(referenceEdge?.provenance).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits capability-specific ingest provenance for registry-driven text captures before normalization', () => {
    const root = createTempRoot()
    try {
      const cases = [
        {
          fileName: 'github-notes.md',
          sourceUrl: 'https://github.com/mohanagy/sadeem',
          ingestCapabilityId: 'builtin:ingest:github',
        },
        {
          fileName: 'youtube-notes.md',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          ingestCapabilityId: 'builtin:ingest:youtube',
        },
        {
          fileName: 'tweet-notes.md',
          sourceUrl: 'https://x.com/sadeem/status/1234567890',
          ingestCapabilityId: 'builtin:ingest:tweet',
        },
        {
          fileName: 'arxiv-notes.md',
          sourceUrl: 'https://arxiv.org/abs/1706.03762',
          ingestCapabilityId: 'builtin:ingest:arxiv',
        },
        {
          fileName: 'hackernews-notes.md',
          sourceUrl: 'https://news.ycombinator.com/item?id=8863',
          ingestCapabilityId: 'builtin:ingest:hackernews',
        },
      ] as const

      for (const testCase of cases) {
        const filePath = join(root, testCase.fileName)
        writeFileSync(
          filePath,
          [
            '---',
            `source_url: "${testCase.sourceUrl}"`,
            'captured_at: "2026-04-13T00:00:00Z"',
            'author: "Sadeem Team"',
            'contributor: "sadeem"',
            '---',
            '',
            '# Notes',
            '',
            'Captured for metadata parity.',
          ].join('\n'),
          'utf8',
        )

        const result = extract([filePath])
        const fileNode = result.nodes.find((node) => node.label === testCase.fileName)
        const headingNode = result.nodes.find((node) => node.label === 'Notes' && node.source_file === filePath)
        const containsEdge = result.edges.find((edge) => edge.source_file === filePath && edge.relation === 'contains')

        expect(fileNode).toMatchObject({
          source_url: testCase.sourceUrl,
          captured_at: '2026-04-13T00:00:00Z',
          author: 'Sadeem Team',
          contributor: 'sadeem',
          provenance: expect.arrayContaining([expect.objectContaining({ capability_id: testCase.ingestCapabilityId, stage: 'ingest' })]),
        })
        expect(headingNode).toMatchObject({
          provenance: expect.arrayContaining([expect.objectContaining({ capability_id: testCase.ingestCapabilityId, stage: 'ingest' })]),
        })
        expect(containsEdge).toMatchObject({
          provenance: expect.arrayContaining([expect.objectContaining({ capability_id: testCase.ingestCapabilityId, stage: 'ingest' })]),
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps frontmatter-only markdown captures on extract provenance when source_url is absent', () => {
    const root = createTempRoot()
    try {
      const notePath = join(root, 'local-notes.md')
      writeFileSync(notePath, ['---', 'title: "Local Notes"', 'author: "Sadeem Team"', 'contributor: "sadeem"', '---', '', '# Notes'].join('\n'), 'utf8')

      const result = extract([notePath])
      const fileNode = result.nodes.find((node) => node.label === 'local-notes.md')
      const headingNode = result.nodes.find((node) => node.label === 'Notes' && node.source_file === notePath)
      const containsEdge = result.edges.find((edge) => edge.source_file === notePath && edge.relation === 'contains')

      expect(fileNode).toMatchObject({
        title: 'Local Notes',
        author: 'Sadeem Team',
        contributor: 'sadeem',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
      })
      expect(headingNode?.provenance).toEqual([expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })])
      expect(containsEdge?.provenance).toEqual([expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts detected paper files into paper nodes', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(paperPath, '# Abstract\nWe propose a new system.\ndoi:10.1000/example\nSee arXiv 2401.12345\n[1] prior work\n', 'utf8')

      const detection = detect(root)
      const result = extract(detection.files.paper)
      const labels = result.nodes.map((node) => node.label)

      expect(normalizeAssertionPaths(detection.files.paper)).toContain(normalizeAssertionPath(paperPath))
      expect(result.nodes.some((node) => node.file_type === 'paper' && node.label === 'paper.md')).toBe(true)
      expect(labels).toContain('Abstract')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts scholarly citation nodes from markdown papers and ignores fenced code blocks', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(
        paperPath,
        [
          '# Abstract',
          'This work builds on DOI:10.1234/example.5678 and arXiv:2103.12345.',
          'See also \\cite{vaswani2017attention,devlin2018bert}.',
          '```tex',
          '\\cite{ignored2020}',
          'DOI:10.9999/ignored',
          '```',
          '## References',
          '[1] Smith et al. (2020). Foundational Work. DOI:10.5555/foundational',
        ].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const referencesId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'References')?.id
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1234/example.5678')
      const arxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2103.12345')
      const citeKeyNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'cite:vaswani2017attention')
      const secondCiteKeyNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'cite:devlin2018bert')
      const referenceNode = result.nodes.find((node) => node.file_type === 'paper' && node.semantic_kind === 'reference' && String(node.label).startsWith('[1]'))
      const citesEdges = result.edges.filter((edge) => edge.source === abstractId && edge.relation === 'cites')
      const referenceContainsEdge = result.edges.find((edge) => edge.source === referencesId && edge.target === referenceNode?.id && edge.relation === 'contains')
      const doiId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1234/example.5678')?.id
      const arxivId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2103.12345')?.id
      const citeKeyId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'cite:vaswani2017attention')?.id
      const secondCiteKeyId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'cite:devlin2018bert')?.id
      const referenceNodeId = result.nodes.find((node) => node.file_type === 'paper' && node.semantic_kind === 'reference' && String(node.label).startsWith('[1]'))?.id
      const semanticNodes = [doiNode, arxivNode, citeKeyNode, secondCiteKeyNode, referenceNode]
      const semanticEdges = [...citesEdges, referenceContainsEdge]

      expect(abstractId).toBeTruthy()
      expect(referencesId).toBeTruthy()
      expect(doiId).toBeTruthy()
      expect(arxivId).toBeTruthy()
      expect(citeKeyId).toBeTruthy()
      expect(secondCiteKeyId).toBeTruthy()
      expect(referenceNodeId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === doiId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === arxivId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === citeKeyId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === secondCiteKeyId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referencesId && edge.target === referenceNodeId && edge.relation === 'contains')).toBe(true)
      expect(semanticNodes).toHaveLength(5)
      expect(semanticEdges).toHaveLength(5)
      expect(semanticNodes.every((node) => node?.layer === 'base')).toBe(true)
      expect(semanticEdges.every((edge) => edge?.layer === 'base')).toBe(true)
      expect(semanticNodes.every((node) => Array.isArray(node?.provenance) && node.provenance.length > 0)).toBe(true)
      expect(semanticEdges.every((edge) => Array.isArray(edge?.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const node of semanticNodes) {
        expect(node).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
      for (const edge of semanticEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
      expect(result.nodes.some((node) => String(node.label).includes('ignored2020'))).toBe(false)
      expect(result.nodes.some((node) => String(node.label).includes('10.9999/ignored'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('splits multi-key latex citations and enforces the per-line key limit for markdown papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      const primaryKeys = ['vaswani2017attention', 'devlin2018bert', 'raffel2020t5']
      const overflowKeys = Array.from({ length: 18 }, (_, index) => `overflow${index + 1}`)

      writeFileSync(
        paperPath,
        [
          '# Abstract',
          'We also reference DOI:10.1234/bootstrap.1 for classification.',
          `See also \\cite{${primaryKeys.join(',')}} for background.`,
          `Benchmark against \\citep{${overflowKeys.join(',')}} when comparing results.`,
        ].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const citationKeyNodes = result.nodes.filter((node) => node.file_type === 'paper' && node.citation_kind === 'citation_key')
      const citationKeyNodeIds = new Set(citationKeyNodes.map((node) => node.id))
      const citationKeyLabels = new Set(citationKeyNodes.map((node) => node.label))
      const citesEdges = result.edges.filter((edge) => edge.source === abstractId && edge.relation === 'cites' && citationKeyNodeIds.has(edge.target))

      expect(abstractId).toBeTruthy()
      expect(citationKeyNodes).toHaveLength(primaryKeys.length + 16)
      for (const key of primaryKeys) {
        expect(citationKeyLabels.has(`cite:${key}`)).toBe(true)
      }
      for (const key of overflowKeys.slice(0, 16)) {
        expect(citationKeyLabels.has(`cite:${key}`)).toBe(true)
      }
      expect(citationKeyLabels.has('cite:overflow17')).toBe(false)
      expect(citationKeyLabels.has('cite:overflow18')).toBe(false)
      expect(citesEdges).toHaveLength(primaryKeys.length + 16)
      expect(citationKeyNodes.every((node) => node.layer === 'base')).toBe(true)
      expect(citesEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(citationKeyNodes.every((node) => Array.isArray(node.provenance) && node.provenance.length > 0)).toBe(true)
      expect(citesEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const node of citationKeyNodes) {
        expect(node).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
      for (const edge of citesEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts arxiv citation format variants from markdown papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      const expectedArxivNodes = [
        { label: 'arXiv:math.CO/0123456', source_url: 'https://arxiv.org/abs/math.CO/0123456' },
        { label: 'arXiv:2103.12345', source_url: 'https://arxiv.org/abs/2103.12345' },
        { label: 'arXiv:2103.54321v2', source_url: 'https://arxiv.org/abs/2103.54321v2' },
        { label: 'arXiv:2201.99999', source_url: 'https://arxiv.org/abs/2201.99999' },
        { label: 'arXiv:2302.00001', source_url: 'https://arxiv.org/abs/2302.00001' },
      ]

      writeFileSync(
        paperPath,
        ['# Abstract', 'We compare arXiv:math.CO/0123456, arXiv:2103.12345, arXiv:2103.54321v2, arxiv.org/abs/2201.99999, and ArXiV: 2302.00001.'].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const citesEdges = result.edges.filter((edge) => edge.source === abstractId && edge.relation === 'cites')

      expect(abstractId).toBeTruthy()
      expect(citesEdges).toHaveLength(expectedArxivNodes.length)
      for (const expectedNode of expectedArxivNodes) {
        const node = result.nodes.find((candidate) => candidate.file_type === 'paper' && candidate.label === expectedNode.label)
        const edge = result.edges.find((candidate) => candidate.source === abstractId && candidate.target === node?.id && candidate.relation === 'cites')

        expect(node).toMatchObject({
          source_url: expectedNode.source_url,
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves inline numeric citations to numbered references and enriches reference metadata', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(
        paperPath,
        [
          '# Abstract',
          'We build on [1] and extend the comparison in [2-3].',
          '## References',
          '[1] Smith et al. (2020). Foundational Work. DOI:10.5555/foundational',
          '[2] Doe and Roe (2021). Follow Up Study. arXiv:2401.12345',
          '[3] Lee (2022). Another Paper.',
        ].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const referenceOne = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)
      const referenceTwo = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 2)
      const referenceThree = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 3)
      const referenceDoiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.5555/foundational')
      const referenceArxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2401.12345')
      const numberedReferences = [referenceOne, referenceTwo, referenceThree]
      const citesEdges = result.edges.filter((edge) => edge.source === abstractId && edge.relation === 'cites')
      const referenceSourceEdges = result.edges.filter((edge) => edge.relation === 'cites' && (edge.source === referenceOne?.id || edge.source === referenceTwo?.id))

      expect(abstractId).toBeTruthy()
      expect(referenceOne).toMatchObject({
        reference_index: 1,
        reference_year: 2020,
        reference_title: 'Foundational Work',
        doi: '10.5555/foundational',
        source_url: 'https://doi.org/10.5555/foundational',
      })
      expect(referenceTwo).toMatchObject({
        reference_index: 2,
        reference_year: 2021,
        reference_title: 'Follow Up Study',
        arxiv_id: '2401.12345',
        source_url: 'https://arxiv.org/abs/2401.12345',
      })
      expect(referenceThree).toMatchObject({
        reference_index: 3,
        reference_year: 2022,
        reference_title: 'Another Paper',
      })
      expect(referenceDoiNode).toMatchObject({
        source_url: 'https://doi.org/10.5555/foundational',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
      })
      expect(referenceArxivNode).toMatchObject({
        source_url: 'https://arxiv.org/abs/2401.12345',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
      })
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === referenceOne?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === referenceTwo?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === referenceThree?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referenceOne?.id && edge.target === referenceDoiNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referenceTwo?.id && edge.target === referenceArxivNode?.id && edge.relation === 'cites')).toBe(true)
      expect(numberedReferences).toHaveLength(3)
      expect(citesEdges).toHaveLength(3)
      expect(referenceSourceEdges).toHaveLength(2)
      expect(numberedReferences.every((node) => node?.layer === 'base')).toBe(true)
      expect(citesEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(referenceSourceEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(numberedReferences.every((node) => Array.isArray(node?.provenance) && node.provenance.length > 0)).toBe(true)
      expect(citesEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(referenceSourceEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const node of numberedReferences) {
        expect(node).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
      for (const edge of citesEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
      for (const edge of referenceSourceEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts explicit bibliography urls into markdown paper references when no doi or arxiv is present', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(
        paperPath,
        [
          '# Abstract',
          'We compare the baselines in [1-2].',
          '## References',
          '[1] Smith et al. (2024). External Runtime Paper. https://example.com/runtime-paper.html.',
          '[2] Doe et al. (2025). Follow Up Appendix. https://example.com/follow-up.pdf,',
        ].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const referenceOne = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)
      const referenceTwo = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 2)

      expect(referenceOne).toMatchObject({
        reference_index: 1,
        reference_year: 2024,
        reference_title: 'External Runtime Paper',
        source_url: 'https://example.com/runtime-paper.html',
      })
      expect(referenceTwo).toMatchObject({
        reference_index: 2,
        reference_year: 2025,
        reference_title: 'Follow Up Appendix',
        source_url: 'https://example.com/follow-up.pdf',
      })
      expect(referenceOne?.doi).toBeUndefined()
      expect(referenceOne?.arxiv_id).toBeUndefined()
      expect(referenceTwo?.doi).toBeUndefined()
      expect(referenceTwo?.arxiv_id).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps doi and arxiv source urls canonical when markdown bibliography entries also include plain urls', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(
        paperPath,
        [
          '# Abstract',
          'We compare the baselines in [1-2].',
          '## References',
          '[1] Smith et al. (2024). Runtime Paper. https://example.com/runtime-paper DOI:10.4242/runtime.paper',
          '[2] Doe et al. (2025). Follow Up Study. https://example.com/follow-up arXiv:2502.54321',
        ].join('\n'),
        'utf8',
      )

      const result = extract([paperPath])
      const referenceOne = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)
      const referenceTwo = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 2)

      expect(referenceOne).toMatchObject({
        reference_index: 1,
        doi: '10.4242/runtime.paper',
        source_url: 'https://doi.org/10.4242/runtime.paper',
      })
      expect(referenceTwo).toMatchObject({
        reference_index: 2,
        arxiv_id: '2502.54321',
        source_url: 'https://arxiv.org/abs/2502.54321',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts heuristic title and section nodes from simple pdf papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      writeFileSync(paperPath, '%PDF-1.4\n1 0 obj\n<< /Title (Sadeem Paper) >>\nstream\n(Abstract) Tj\n(Introduction) Tj\nendstream\nendobj\n', 'latin1')

      const result = extract([paperPath])
      const labels = result.nodes.filter((node) => node.file_type === 'paper').map((node) => node.label)

      expect(labels).toContain('paper.pdf')
      expect(labels).toContain('Sadeem Paper')
      expect(labels).toContain('Abstract')
      expect(labels).toContain('Introduction')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts local filename mentions from simple pdf papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      const guidePath = join(root, 'guide.md')
      writeFileSync(guidePath, '# Guide\n', 'utf8')
      writeFileSync(paperPath, '%PDF-1.4\n1 0 obj\n<< /Title (Sadeem Paper) >>\nstream\n(Abstract) Tj\n(See guide.md for details) Tj\nendstream\nendobj\n', 'latin1')

      const result = extract([paperPath, guidePath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const guideId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'guide.md')?.id
      const referenceEdge = result.edges.find((edge) => edge.source === abstractId && edge.target === guideId && edge.relation === 'references')

      expect(abstractId).toBeTruthy()
      expect(guideId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === guideId && edge.relation === 'references')).toBe(true)
      expect(referenceEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts citation identifiers from simple pdf papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      writeFileSync(
        paperPath,
        '%PDF-1.4\n1 0 obj\n<< /Title (Sadeem Paper) >>\nstream\n(Abstract) Tj\n(See DOI:10.1000/example.42 and arXiv:2501.12345) Tj\nendstream\nendobj\n',
        'latin1',
      )

      const result = extract([paperPath])
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const doiId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1000/example.42')?.id
      const arxivId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2501.12345')?.id

      expect(abstractId).toBeTruthy()
      expect(doiId).toBeTruthy()
      expect(arxivId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === doiId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === arxivId && edge.relation === 'cites')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts pdf metadata, inline numeric citation resolution, TJ-array text, and resolved reference source urls', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      writeFileSync(
        paperPath,
        [
          '%PDF-1.4',
          '1 0 obj',
          '<< /Title (Sadeem Paper) /Author (Jane Doe) /Subject (Runtime Notes) >>',
          'stream',
          '[(Abstract)] TJ',
          '(We build on [1] and compare against [2].) Tj',
          '[(See DOI:10.1000/example.42 and arXiv:2501.12345)] TJ',
          '[(References)] TJ',
          '([1] Doe et al. (2024). Runtime Paper. DOI:10.4242/runtime.paper) Tj',
          '([2] Roe et al. (2025). Follow Up Paper. arXiv:2502.54321) Tj',
          'endstream',
          'endobj',
        ].join('\n'),
        'latin1',
      )

      const result = extract([paperPath])
      const paperNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'paper.pdf')
      const abstractId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'Abstract')?.id
      const referencesId = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'References')?.id
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1000/example.42')
      const arxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2501.12345')
      const referenceNode = result.nodes.find(
        (node) => node.file_type === 'paper' && node.semantic_kind === 'reference' && String(node.label).startsWith('[1] Doe et al.'),
      )
      const referenceTwo = result.nodes.find(
        (node) => node.file_type === 'paper' && node.semantic_kind === 'reference' && String(node.label).startsWith('[2] Roe et al.'),
      )
      const referenceDoiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.4242/runtime.paper')
      const referenceArxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2502.54321')
      const doiCitationEdge = result.edges.find((edge) => edge.source === abstractId && edge.target === doiNode?.id && edge.relation === 'cites')
      const referenceContainsEdges = result.edges.filter((edge) => edge.source === referencesId && edge.relation === 'contains')
      const referenceCitationEdge = result.edges.find((edge) => edge.source === referenceNode?.id && edge.target === referenceDoiNode?.id && edge.relation === 'cites')
      const referenceArxivEdge = result.edges.find((edge) => edge.source === referenceTwo?.id && edge.target === referenceArxivNode?.id && edge.relation === 'cites')
      const abstractReferenceEdges = result.edges.filter(
        (edge) => edge.source === abstractId && edge.relation === 'cites' && (edge.target === referenceNode?.id || edge.target === referenceTwo?.id),
      )

      expect(paperNode).toMatchObject({
        title: 'Sadeem Paper',
        author: 'Jane Doe',
        subject: 'Runtime Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(abstractId).toBeTruthy()
      expect(doiNode).toMatchObject({
        source_url: 'https://doi.org/10.1000/example.42',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(arxivNode).toMatchObject({
        source_url: 'https://arxiv.org/abs/2501.12345',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceNode).toMatchObject({
        reference_index: 1,
        reference_year: 2024,
        reference_title: 'Runtime Paper',
        doi: '10.4242/runtime.paper',
        source_url: 'https://doi.org/10.4242/runtime.paper',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceDoiNode).toMatchObject({
        source_url: 'https://doi.org/10.4242/runtime.paper',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceTwo).toMatchObject({
        reference_index: 2,
        reference_year: 2025,
        reference_title: 'Follow Up Paper',
        arxiv_id: '2502.54321',
        source_url: 'https://arxiv.org/abs/2502.54321',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceArxivNode).toMatchObject({
        source_url: 'https://arxiv.org/abs/2502.54321',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(doiCitationEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceCitationEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(referenceArxivEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
      })
      expect(abstractReferenceEdges).toHaveLength(2)
      expect(referenceContainsEdges).toHaveLength(2)
      expect(referenceContainsEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(referenceContainsEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(abstractReferenceEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(abstractReferenceEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === doiNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === arxivNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referencesId && edge.target === referenceNode?.id && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referencesId && edge.target === referenceTwo?.id && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === referenceNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === abstractId && edge.target === referenceTwo?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referenceNode?.id && edge.target === referenceDoiNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === referenceTwo?.id && edge.target === referenceArxivNode?.id && edge.relation === 'cites')).toBe(true)
      for (const edge of referenceContainsEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
        })
      }
      for (const edge of abstractReferenceEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:paper', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts explicit bibliography urls into pdf reference metadata when no doi or arxiv is present', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      writeFileSync(
        paperPath,
        [
          '%PDF-1.4',
          '1 0 obj',
          '<< /Title (Sadeem Paper) >>',
          'stream',
          '(Abstract) Tj',
          '([1]) Tj',
          '(References) Tj',
          '([1] Doe et al. (2024). Runtime Paper. https://example.com/runtime-paper.pdf.) Tj',
          'endstream',
          'endobj',
        ].join('\n'),
        'latin1',
      )

      const result = extract([paperPath])
      const referenceNode = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)

      expect(referenceNode).toMatchObject({
        reference_index: 1,
        reference_year: 2024,
        reference_title: 'Runtime Paper',
        source_url: 'https://example.com/runtime-paper.pdf',
      })
      expect(referenceNode?.doi).toBeUndefined()
      expect(referenceNode?.arxiv_id).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a document node for plain text without headings', () => {
    const root = createTempRoot()
    try {
      const notesPath = join(root, 'notes.txt')
      writeFileSync(notesPath, 'Plain text with no headings at all.', 'utf8')

      const result = extract([notesPath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({ label: 'notes.txt', file_type: 'document' })
      expect(result.edges).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts heading structure from docx documents', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>Body paragraph</w:t></w:r></w:p>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
        'docProps/core.xml': strToU8(
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Guide Title</dc:title></cp:coreProperties>',
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])
      const labels = result.nodes.map((node) => node.label)
      const titleNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Guide Title')
      const overviewNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Overview')
      const detailsNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Details')
      const fileNodeId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'guide.docx')?.id
      const nodeByKey = new Map(result.nodes.map((node) => [`${node.file_type}:${node.label}`, node.id]))
      const relations = new Set(result.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`))
      const containsEdges = result.edges.filter((edge) => edge.relation === 'contains')

      expect(labels).toContain('guide.docx')
      expect(labels).toContain('Guide Title')
      expect(labels).toContain('Overview')
      expect(labels).toContain('Details')
      expect(titleNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(overviewNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(detailsNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(relations.has(`${fileNodeId}:contains:${nodeByKey.get('document:Guide Title')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:guide.docx')}:contains:${nodeByKey.get('document:Overview')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:contains:${nodeByKey.get('document:Details')}`)).toBe(true)
      expect(containsEdges).toHaveLength(3)
      expect(containsEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(containsEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const edge of containsEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts local filename mentions from docx body paragraphs', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const linkedGuidePath = join(root, 'linked-guide.md')
      writeFileSync(linkedGuidePath, '# Linked Guide\n', 'utf8')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>See linked-guide.md for details.</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath, linkedGuidePath])
      const overviewId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Overview')?.id
      const linkedGuideId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'linked-guide.md')?.id
      const referenceEdge = result.edges.find((edge) => edge.source === overviewId && edge.target === linkedGuideId && edge.relation === 'references')

      expect(overviewId).toBeTruthy()
      expect(linkedGuideId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === overviewId && edge.target === linkedGuideId && edge.relation === 'references')).toBe(true)
      expect(referenceEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts citation identifiers from docx body paragraphs', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>See DOI:10.1000/guide.1 and arXiv:2401.12345 for background.</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])
      const overviewId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Overview')?.id
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1000/guide.1')
      const arxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2401.12345')
      const doiId = doiNode?.id
      const arxivId = arxivNode?.id
      const doiEdge = result.edges.find((edge) => edge.source === overviewId && edge.target === doiId && edge.relation === 'cites')
      const arxivEdge = result.edges.find((edge) => edge.source === overviewId && edge.target === arxivId && edge.relation === 'cites')

      expect(overviewId).toBeTruthy()
      expect(doiId).toBeTruthy()
      expect(arxivId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === overviewId && edge.target === doiId && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === overviewId && edge.target === arxivId && edge.relation === 'cites')).toBe(true)
      expect(doiNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(arxivNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(doiEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(arxivEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts docx core metadata and resolved citation source urls', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>See DOI:10.1000/guide.1 for background.</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
        'docProps/core.xml': strToU8(
          [
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
            '  <dc:title>Guide Title</dc:title>',
            '  <dc:creator>Jane Doe</dc:creator>',
            '  <dc:subject>Design Notes</dc:subject>',
            '  <dc:description>Background material for the graph runtime.</dc:description>',
            '</cp:coreProperties>',
          ].join(''),
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))
      writeFileSync(
        binaryIngestSidecarPath(docxPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/guide.docx',
            captured_at: '2026-04-14T01:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([docxPath])
      const fileNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'guide.docx')
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1000/guide.1')
      const doiEdge = result.edges.find((edge) => edge.relation === 'cites' && edge.target === doiNode?.id)

      expect(fileNode).toMatchObject({
        title: 'Guide Title',
        author: 'Jane Doe',
        subject: 'Design Notes',
        description: 'Background material for the graph runtime.',
        source_url: 'https://example.com/guide.docx',
        captured_at: '2026-04-14T01:00:00Z',
        contributor: 'sadeem',
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/guide.docx',
            captured_at: '2026-04-14T01:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(doiNode).toMatchObject({
        source_url: 'https://doi.org/10.1000/guide.1',
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(doiEdge).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(fileNode?.provenance).toHaveLength(2)
      expect(doiNode?.provenance).toHaveLength(2)
      expect(doiEdge?.provenance).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts numbered reference entries, bibliography detection, and inline citation resolution from docx sections', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'paper.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>We build on [1] and extend the comparison in [2-3].</w:t></w:r></w:p>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Bibliography</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>[1] Smith et al. (2024). Foundational Work. DOI:10.1234/example</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>[2] Doe et al. (2025). Follow Up Study. arXiv:2501.12345</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>[3] Lee (2026). Another Paper.</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])
      const introductionId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Introduction')?.id
      const bibliographyId = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Bibliography')?.id
      const referenceNode = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)
      const referenceTwo = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 2)
      const referenceThree = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 3)
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1234/example')
      const arxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2501.12345')
      const containsEdges = result.edges.filter((edge) => edge.source === bibliographyId && edge.relation === 'contains')
      const introReferenceEdges = result.edges.filter(
        (edge) => edge.source === introductionId && edge.relation === 'cites' && [referenceNode?.id, referenceTwo?.id, referenceThree?.id].includes(edge.target),
      )
      const citesEdge = result.edges.find((edge) => edge.source === referenceNode?.id && edge.target === doiNode?.id && edge.relation === 'cites')
      const arxivCitesEdge = result.edges.find((edge) => edge.source === referenceTwo?.id && edge.target === arxivNode?.id && edge.relation === 'cites')

      expect(introductionId).toBeTruthy()
      expect(bibliographyId).toBeTruthy()
      expect(referenceNode).toMatchObject({
        semantic_kind: 'reference',
        reference_index: 1,
        reference_year: 2024,
        reference_title: 'Foundational Work',
        doi: '10.1234/example',
        source_url: 'https://doi.org/10.1234/example',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(referenceTwo).toMatchObject({
        semantic_kind: 'reference',
        reference_index: 2,
        reference_year: 2025,
        reference_title: 'Follow Up Study',
        arxiv_id: '2501.12345',
        source_url: 'https://arxiv.org/abs/2501.12345',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(referenceThree).toMatchObject({
        semantic_kind: 'reference',
        reference_index: 3,
        reference_year: 2026,
        reference_title: 'Another Paper',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(doiNode).toMatchObject({
        source_url: 'https://doi.org/10.1234/example',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(arxivNode).toMatchObject({
        source_url: 'https://arxiv.org/abs/2501.12345',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(citesEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(arxivCitesEdge).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(containsEdges).toHaveLength(3)
      expect(introReferenceEdges).toHaveLength(3)
      expect(containsEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(containsEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(introReferenceEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(introReferenceEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      expect(result.edges.some((edge) => edge.source === bibliographyId && edge.target === referenceNode?.id && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bibliographyId && edge.target === referenceTwo?.id && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === bibliographyId && edge.target === referenceThree?.id && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === introductionId && edge.target === referenceNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === introductionId && edge.target === referenceTwo?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === introductionId && edge.target === referenceThree?.id && edge.relation === 'cites')).toBe(true)
      for (const edge of containsEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
        })
      }
      for (const edge of introReferenceEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lifts explicit bibliography urls into docx reference metadata when no doi or arxiv is present', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Bibliography</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>[1] Smith et al. (2024). Runtime Paper. https://example.com/runtime-paper.html.</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])
      const referenceNode = result.nodes.find((node) => node.file_type === 'paper' && node.reference_index === 1)

      expect(referenceNode).toMatchObject({
        semantic_kind: 'reference',
        reference_index: 1,
        reference_year: 2024,
        reference_title: 'Runtime Paper',
        source_url: 'https://example.com/runtime-paper.html',
      })
      expect(referenceNode?.doi).toBeUndefined()
      expect(referenceNode?.arxiv_id).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts workbook metadata and sheet nodes from xlsx documents', () => {
    const root = createTempRoot()
    try {
      const workbookPath = join(root, 'metrics.xlsx')
      const archive = zipSync({
        'xl/workbook.xml': strToU8(
          [
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <sheets>',
            '    <sheet name="Summary" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
            '    <sheet name="Experiments" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
            '  </sheets>',
            '</workbook>',
          ].join(''),
        ),
        'docProps/core.xml': strToU8(
          [
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
            '  <dc:title>Metrics Workbook</dc:title>',
            '  <dc:creator>Jane Doe</dc:creator>',
            '</cp:coreProperties>',
          ].join(''),
        ),
      })

      writeFileSync(workbookPath, Buffer.from(archive))
      writeFileSync(
        binaryIngestSidecarPath(workbookPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/metrics.xlsx',
            captured_at: '2026-04-14T02:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([workbookPath])
      const labels = result.nodes.filter((node) => node.file_type === 'document').map((node) => node.label)
      const workbookNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'metrics.xlsx')
      const summaryNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Summary')
      const experimentsNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'Experiments')
      const nodeByKey = new Map(result.nodes.map((node) => [`${node.file_type}:${node.label}`, node.id]))
      const relations = new Set(result.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`))
      const containsEdges = result.edges.filter((edge) => edge.source === workbookNode?.id && edge.relation === 'contains')

      expect(workbookNode).toMatchObject({
        title: 'Metrics Workbook',
        author: 'Jane Doe',
        source_url: 'https://example.com/metrics.xlsx',
        captured_at: '2026-04-14T02:00:00Z',
        contributor: 'sadeem',
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/metrics.xlsx',
            captured_at: '2026-04-14T02:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(summaryNode).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(experimentsNode).toMatchObject({
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
        ]),
      })
      expect(labels).toContain('Summary')
      expect(labels).toContain('Experiments')
      expect(relations.has(`${nodeByKey.get('document:metrics.xlsx')}:contains:${nodeByKey.get('document:Summary')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:metrics.xlsx')}:contains:${nodeByKey.get('document:Experiments')}`)).toBe(true)
      expect(containsEdges).toHaveLength(2)
      expect(containsEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(containsEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length === 2)).toBe(true)
      expect(workbookNode?.provenance).toHaveLength(2)
      expect(summaryNode?.provenance).toHaveLength(2)
      expect(experimentsNode?.provenance).toHaveLength(2)
      for (const edge of containsEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: expect.arrayContaining([
            expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' }),
            expect.objectContaining({ capability_id: 'builtin:ingest:webpage', stage: 'ingest' }),
          ]),
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts citation nodes from xlsx shared strings', () => {
    const root = createTempRoot()
    try {
      const workbookPath = join(root, 'citations.xlsx')
      const archive = zipSync({
        'xl/workbook.xml': strToU8(
          [
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <sheets>',
            '    <sheet name="Summary" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
            '  </sheets>',
            '</workbook>',
          ].join(''),
        ),
        'xl/sharedStrings.xml': strToU8(
          [
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <si><t>See DOI:10.1234/example.5678 and arXiv:2103.12345 for details.</t></si>',
            '</sst>',
          ].join(''),
        ),
      })

      writeFileSync(workbookPath, Buffer.from(archive))

      const result = extract([workbookPath])
      const workbookNode = result.nodes.find((node) => node.file_type === 'document' && node.label === 'citations.xlsx')
      const doiNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'DOI:10.1234/example.5678')
      const arxivNode = result.nodes.find((node) => node.file_type === 'paper' && node.label === 'arXiv:2103.12345')
      const citesEdges = result.edges.filter((edge) => edge.source === workbookNode?.id && edge.relation === 'cites')

      expect(workbookNode).toBeTruthy()
      expect(doiNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' })],
      })
      expect(arxivNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' })],
      })
      expect(result.edges.some((edge) => edge.source === workbookNode?.id && edge.target === doiNode?.id && edge.relation === 'cites')).toBe(true)
      expect(result.edges.some((edge) => edge.source === workbookNode?.id && edge.target === arxivNode?.id && edge.relation === 'cites')).toBe(true)
      expect(citesEdges).toHaveLength(2)
      expect(citesEdges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(citesEdges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
      for (const edge of citesEdges) {
        expect(edge).toMatchObject({
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:xlsx', stage: 'extract' })],
        })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for corrupted docx archives', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'broken.docx')
      writeFileSync(docxPath, Buffer.from('not-a-zip-archive'), 'utf8')
      writeFileSync(
        binaryIngestSidecarPath(docxPath),
        JSON.stringify(
          {
            source_url: 'https://example.com/broken.docx',
            captured_at: '2026-04-14T03:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const result = extract([docxPath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({
        label: 'broken.docx',
        file_type: 'document',
        source_url: 'https://example.com/broken.docx',
        captured_at: '2026-04-14T03:00:00Z',
        contributor: 'sadeem',
        layer: 'base',
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://example.com/broken.docx',
            captured_at: '2026-04-14T03:00:00Z',
            contributor: 'sadeem',
          }),
        ]),
      })
      expect(result.nodes[0]?.provenance).toHaveLength(2)
      expect(result.edges).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for oversized docx entries', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'large.docx')
      const oversizedXml = `<w:document><w:body><w:p><w:r><w:t>${'A'.repeat(4_194_305)}</w:t></w:r></w:p></w:body></w:document>`
      const archive = zipSync({
        'word/document.xml': strToU8(oversizedXml),
      })
      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({
        label: 'large.docx',
        file_type: 'document',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:docx', stage: 'extract' })],
      })
      expect(result.edges).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores markdown references outside the extracted corpus', () => {
    const root = createTempRoot()
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })

      const readmePath = join(projectDir, 'README.md')
      const externalPath = join(root, 'secret.md')
      writeFileSync(readmePath, '# Overview\nSee [Secret](../secret.md)\n', 'utf8')
      writeFileSync(externalPath, '# Secret\n', 'utf8')

      const result = extract([readmePath])

      expect(result.nodes.some((node) => node.label === 'secret.md')).toBe(false)
      expect(result.edges.some((edge) => edge.relation === 'references')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not emit dangling internal js or ts edges', () => {
    const result = extractJs(join(FIXTURES_DIR, 'sample.ts'))
    const nodeIds = new Set(result.nodes.map((node) => node.id))

    for (const edge of result.edges) {
      if (edge.relation === 'contains' || edge.relation === 'method' || edge.relation === 'calls') {
        expect(nodeIds.has(edge.source)).toBe(true)
      }
    }
  })

  it('collects supported code files and skips hidden paths', () => {
    const files = collectFiles(FIXTURES_DIR)

    expect(files.length).toBeGreaterThan(0)
    for (const filePath of files) {
      expect(
        [
          '.py',
          '.js',
          '.ts',
          '.tsx',
          '.go',
          '.rs',
          '.java',
          '.c',
          '.cpp',
          '.cc',
          '.cxx',
          '.rb',
          '.cs',
          '.kt',
          '.kts',
          '.scala',
          '.php',
          '.h',
          '.hpp',
          '.swift',
          '.lua',
          '.toc',
          '.zig',
          '.ps1',
          '.ex',
          '.exs',
          '.m',
          '.mm',
          '.jl',
        ].includes(filePath.slice(filePath.lastIndexOf('.'))),
      ).toBe(true)
      const fixtureRelativePath = relative(FIXTURES_DIR, filePath)
      expect(fixtureRelativePath.split(/[\\/]/).some((part) => part.startsWith('.'))).toBe(false)
    }
  })

  it('collects symlinked files when requested', () => {
    const root = createTempRoot()
    try {
      const realDir = join(root, 'real_src')
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, 'lib.py'), 'x = 1', 'utf8')
      symlinkSync(realDir, join(root, 'linked_src'))

      const filesWithoutSymlinks = collectFiles(root)
      const filesWithSymlinks = collectFiles(root, { followSymlinks: true })

      expect(filesWithoutSymlinks.filter((filePath) => filePath.endsWith('lib.py'))).toHaveLength(1)
      expect(filesWithSymlinks.filter((filePath) => filePath.endsWith('lib.py'))).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts multiple files with zero token counts', () => {
    const result = extract([join(FIXTURES_DIR, 'sample.py'), join(FIXTURES_DIR, 'sample.ts')])
    const sourceFiles = new Set(result.nodes.map((node) => node.source_file))

    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.input_tokens).toBe(0)
    expect(result.output_tokens).toBe(0)
    expect([...sourceFiles].some((filePath) => filePath.endsWith('sample.py'))).toBe(true)
    expect([...sourceFiles].some((filePath) => filePath.endsWith('sample.ts'))).toBe(true)
  })

  it('returns consistent cached extraction results and invalidates on file changes', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      const first = extract([filePath])
      const second = extract([filePath])

      expect(first.nodes).toEqual(second.nodes)
      expect(first.edges).toEqual(second.edges)

      writeFileSync(filePath, 'def foo():\n    pass\n\ndef bar():\n    pass\n', 'utf8')
      const third = extract([filePath])
      const labels = third.nodes.map((node) => node.label)

      expect(labels.some((label) => label.includes('bar'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns consistent cached document extraction results and invalidates on file changes', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'notes.md')
      writeFileSync(filePath, '# Overview\n', 'utf8')
      const first = extract([filePath])
      const second = extract([filePath])

      expect(first.nodes).toEqual(second.nodes)
      expect(first.edges).toEqual(second.edges)

      writeFileSync(filePath, '# Overview\n## Details\n', 'utf8')
      const third = extract([filePath])

      expect(third.nodes.some((node) => node.label === 'Details')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('invalidates cached binary extraction results when hidden ingest sidecar metadata changes', () => {
    const root = createTempRoot()
    try {
      const imagePath = join(root, 'diagram.png')
      writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]))
      writeFileSync(
        binaryIngestSidecarPath(imagePath),
        JSON.stringify(
          {
            source_url: 'https://example.com/diagram-v1.png',
            captured_at: '2026-04-13T06:00:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const first = extract([imagePath])
      const second = extract([imagePath])

      expect(first.nodes).toEqual(second.nodes)
      expect(second.nodes.find((node) => node.label === 'diagram.png')?.source_url).toBe('https://example.com/diagram-v1.png')

      writeFileSync(
        binaryIngestSidecarPath(imagePath),
        JSON.stringify(
          {
            source_url: 'https://example.com/diagram-v2.png',
            captured_at: '2026-04-13T06:05:00Z',
            contributor: 'sadeem',
          },
          null,
          2,
        ),
        'utf8',
      )

      const third = extract([imagePath])

      expect(third.nodes.find((node) => node.label === 'diagram.png')?.source_url).toBe('https://example.com/diagram-v2.png')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for oversized text documents', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'large.md')
      writeFileSync(filePath, `# Oversized\n${'a'.repeat(MAX_TEXT_BYTES + 1)}`, 'utf8')

      const result = extract([filePath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({
        label: 'large.md',
        file_type: 'document',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
      })
      expect(result.edges).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers gracefully from corrupted cache entries', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      extract([filePath])

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(cachePath, '{not valid json', 'utf8')

      const recovered = extract([filePath])

      expect(recovered.nodes.some((node) => node.label === 'foo()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores stale extractor cache versions', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      extract([filePath])

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(cachePath, JSON.stringify({ __sadeemTsExtractorVersion: 0, nodes: [], edges: [] }), 'utf8')

      const recovered = extract([filePath])

      expect(recovered.nodes.some((node) => node.label === 'foo()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached raw extractions from the pre-metadata cache version', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 10,
          nodes: [{ id: 'stale_file', label: 'sample.py', file_type: 'code', source_file: filePath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([filePath])
      const fileNode = recovered.nodes.find((node) => node.label === 'sample.py')

      expect(recovered.nodes.some((node) => node.label === 'foo()')).toBe(true)
      expect(fileNode).toMatchObject({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:python', stage: 'extract' })],
      })
      expect(recovered.edges.every((edge) => edge.layer === 'base')).toBe(true)
      expect(recovered.edges.every((edge) => Array.isArray(edge.provenance) && edge.provenance.length > 0)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-duration cache version', () => {
    const root = createTempRoot()
    try {
      const wavPath = join(root, 'tone.wav')
      const wavBuffer = createTestWavBuffer(1.5)
      writeFileSync(wavPath, wavBuffer)

      const cachePath = join(cacheDir(), `${fileHash(wavPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 13,
          nodes: [{ id: 'stale_audio', label: 'tone.wav', file_type: 'audio', source_file: wavPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([wavPath])
      const wavNode = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'tone.wav')

      expect(wavNode).toMatchObject({
        content_type: 'audio/wav',
        file_bytes: wavBuffer.length,
        media_duration_seconds: 1.5,
        audio_sample_rate_hz: 4000,
        audio_channel_count: 2,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-audio-tag cache version', () => {
    const root = createTempRoot()
    try {
      const mp3Path = join(root, 'episode.mp3')
      const mp3Buffer = createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(mp3Path, mp3Buffer)

      const cachePath = join(cacheDir(), `${fileHash(mp3Path)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 14,
          nodes: [{ id: 'stale_audio', label: 'episode.mp3', file_type: 'audio', source_file: mp3Path }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mp3Path])
      const mp3Node = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.mp3')

      expect(mp3Node).toMatchObject({
        content_type: 'audio/mpeg',
        file_bytes: mp3Buffer.length,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-flac-ogg-audio cache version', () => {
    const root = createTempRoot()
    try {
      const flacPath = join(root, 'episode.flac')
      const flacBuffer = createTestFlacBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(flacPath, flacBuffer)

      const cachePath = join(cacheDir(), `${fileHash(flacPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 15,
          nodes: [{ id: 'stale_audio', label: 'episode.flac', file_type: 'audio', source_file: flacPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([flacPath])
      const flacNode = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.flac')

      expect(flacNode).toMatchObject({
        content_type: 'audio/flac',
        file_bytes: flacBuffer.length,
        media_duration_seconds: 3.75,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-aac-m4a cache version', () => {
    const root = createTempRoot()
    try {
      const m4aPath = join(root, 'episode.m4a')
      const m4aBuffer = createTestM4aBuffer({
        title: 'Roadmap Review',
        artist: 'Sadeem FM',
        album: 'Engineering Notes',
      })
      writeFileSync(m4aPath, m4aBuffer)

      const cachePath = join(cacheDir(), `${fileHash(m4aPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 16,
          nodes: [{ id: 'stale_audio', label: 'episode.m4a', file_type: 'audio', source_file: m4aPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([m4aPath])
      const m4aNode = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'episode.m4a')

      expect(m4aNode).toMatchObject({
        content_type: 'audio/mp4',
        file_bytes: m4aBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        audio_title: 'Roadmap Review',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-video-container cache version', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'session.webm')
      const webmBuffer = createTestMatroskaBuffer()
      writeFileSync(webmPath, webmBuffer)

      const cachePath = join(cacheDir(), `${fileHash(webmPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 17,
          nodes: [{ id: 'stale_video', label: 'session.webm', file_type: 'video', source_file: webmPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([webmPath])
      const webmNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'session.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-avi-video cache version', () => {
    const root = createTempRoot()
    try {
      const aviPath = join(root, 'recording.avi')
      const aviBuffer = createTestAviBuffer({ zeroMainHeaderDuration: true, zeroMainHeaderDimensions: true })
      writeFileSync(aviPath, aviBuffer)

      const cachePath = join(cacheDir(), `${fileHash(aviPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 18,
          nodes: [{ id: 'stale_avi_video', label: 'recording.avi', file_type: 'video', source_file: aviPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([aviPath])
      const aviNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'recording.avi')

      expect(aviNode).toMatchObject({
        content_type: 'video/x-msvideo',
        file_bytes: aviBuffer.length,
        media_duration_seconds: 3.5,
        video_width_px: 640,
        video_height_px: 360,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-avi-video-audio cache version', () => {
    const root = createTempRoot()
    try {
      const aviPath = join(root, 'clip.avi')
      const aviBuffer = createTestAviBuffer({ audioTrackFirst: false })
      writeFileSync(aviPath, aviBuffer)

      const cachePath = join(cacheDir(), `${fileHash(aviPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 24,
          nodes: [{ id: 'stale_avi_video_audio', label: 'clip.avi', file_type: 'video', source_file: aviPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([aviPath])
      const aviNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.avi')

      expect(aviNode).toMatchObject({
        content_type: 'video/x-msvideo',
        file_bytes: aviBuffer.length,
        media_duration_seconds: 3.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 640,
        video_height_px: 360,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-video-audio cache version', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'session.webm')
      const webmBuffer = createTestMatroskaBuffer({ audioTrackFirst: false, includeAudioTrackMetadata: true })
      writeFileSync(webmPath, webmBuffer)

      const cachePath = join(cacheDir(), `${fileHash(webmPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 25,
          nodes: [{ id: 'stale_matroska_video_audio', label: 'session.webm', file_type: 'video', source_file: webmPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([webmPath])
      const webmNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'session.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-window cache version', () => {
    const root = createTempRoot()
    try {
      const webmPath = join(root, 'windowed-session.webm')
      const webmBuffer = createTestMatroskaBuffer({
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 300_000,
      })
      writeFileSync(webmPath, webmBuffer)

      const cachePath = join(cacheDir(), `${fileHash(webmPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 26,
          nodes: [{ id: 'stale_matroska_window', label: 'windowed-session.webm', file_type: 'video', source_file: webmPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([webmPath])
      const webmNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'windowed-session.webm')

      expect(webmNode).toMatchObject({
        content_type: 'video/webm',
        file_bytes: webmBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-seekhead cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-windowed.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 27,
          nodes: [{ id: 'stale_matroska_seekhead', label: 'seekhead-windowed.mkv', file_type: 'video', source_file: mkvPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-windowed.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-seekhead-partial cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-partial.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedTracksBytes: 600_000,
        useSeekHead: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 28,
          nodes: [{ id: 'stale_matroska_seekhead_partial', label: 'seekhead-tracks-partial.mkv', file_type: 'video', source_file: mkvPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-partial.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-discovery-bundle cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-split.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
        useSeekHead: true,
        splitSeekHeads: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 32,
          nodes: [{ id: 'stale_matroska_discovery_bundle', label: 'seekhead-split.mkv', file_type: 'video', source_file: mkvPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-split.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-top-level-fallback cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'top-level-windowed.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        audioTrackFirst: false,
        includeAudioTrackMetadata: true,
        prefixedSegmentBytes: 600_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 33,
          nodes: [{ id: 'stale_matroska_top_level_fallback', label: 'top-level-windowed.mkv', file_type: 'video', source_file: mkvPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'top-level-windowed.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-authoritative-clear cache version when later Info omits duration', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-info-clear-duration.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 34,
          nodes: [{
            id: 'stale_matroska_authoritative_clear_duration',
            label: 'seekhead-info-clear-duration.mkv',
            file_type: 'video',
            source_file: mkvPath,
            media_duration_seconds: 1.5,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-info-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-authoritative-clear cache version when later Tracks omit audio metadata', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-clear-audio.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 34,
          nodes: [{
            id: 'stale_matroska_authoritative_clear_audio',
            label: 'seekhead-tracks-clear-audio.mkv',
            file_type: 'video',
            source_file: mkvPath,
            audio_sample_rate_hz: 8_000,
            audio_channel_count: 1,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-clear-audio.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('audio_sample_rate_hz')
      expect(mkvNode).not.toHaveProperty('audio_channel_count')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-unreadable-tracks cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'seekhead-tracks-unreadable.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 35,
          nodes: [{
            id: 'stale_matroska_unreadable_tracks',
            label: 'seekhead-tracks-unreadable.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'seekhead-tracks-unreadable.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-unreadable-info-stale-direct cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-unreadable-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        prefixedInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 36,
          nodes: [{
            id: 'stale_matroska_unreadable_info_stale_direct',
            label: 'direct-info-unreadable-stale.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-unreadable-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-tracks-prefix-stale cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-padding-corrective.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 37,
          nodes: [{
            id: 'stale_matroska_direct_tracks_prefix_stale',
            label: 'direct-tracks-trailing-padding-corrective.mkv',
            file_type: 'video',
            source_file: mkvPath,
            media_duration_seconds: 4.25,
            video_width_px: 5,
            video_height_px: 2,
            audio_sample_rate_hz: 8_000,
            audio_channel_count: 1,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-padding-corrective.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1280,
        video_height_px: 720,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-clear cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding-clear-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 38,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_clear',
            label: 'direct-info-trailing-padding-clear-duration.mkv',
            file_type: 'video',
            source_file: mkvPath,
            media_duration_seconds: 1.5,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-clear-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-omit cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-padding-omit-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 39,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_omit',
            label: 'direct-info-trailing-padding-omit-duration.mkv',
            file_type: 'video',
            source_file: mkvPath,
            media_duration_seconds: 1.5,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-padding-omit-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-tail cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-omit-duration.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        trailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 40,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_tail',
            label: 'direct-info-trailing-child-omit-duration.mkv',
            file_type: 'video',
            source_file: mkvPath,
            media_duration_seconds: 1.5,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-omit-duration.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
      expect(mkvNode).not.toHaveProperty('media_duration_seconds')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-tail-overrun cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-overrun-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        omitDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 41,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_tail_overrun',
            label: 'direct-info-trailing-child-overrun-stale.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-tail-invalid-overrun cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-invalid-overrun-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        malformedTrailingInfoChildBytes: 1_100_000,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 42,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_tail_invalid_overrun',
            label: 'direct-info-trailing-child-invalid-overrun-stale.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-overrun-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-info-prefix-tail-invalid-truncated cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-info-trailing-child-invalid-truncated-stale.mkv')
      const mkvBuffer = createTestMatroskaBuffer({
        docType: 'matroska',
        staleFirstInfoMetadata: {
          durationSeconds: 1.5,
        },
        malformedDuration: true,
        truncatedTrailingInfoChildHeader: true,
      })
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 43,
          nodes: [{
            id: 'stale_matroska_direct_info_prefix_tail_invalid_truncated',
            label: 'direct-info-trailing-child-invalid-truncated-stale.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-info-trailing-child-invalid-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 1.5,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-matroska-direct-tracks-prefix-tail-truncated cache version', () => {
    const root = createTempRoot()
    try {
      const mkvPath = join(root, 'direct-tracks-trailing-child-truncated-stale.mkv')
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
      writeFileSync(mkvPath, mkvBuffer)

      const cachePath = join(cacheDir(), `${fileHash(mkvPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 44,
          nodes: [{
            id: 'stale_matroska_direct_tracks_prefix_tail_truncated',
            label: 'direct-tracks-trailing-child-truncated-stale.mkv',
            file_type: 'video',
            source_file: mkvPath,
          }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mkvPath])
      const mkvNode = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'direct-tracks-trailing-child-truncated-stale.mkv')

      expect(mkvNode).toMatchObject({
        content_type: 'video/x-matroska',
        file_bytes: mkvBuffer.length,
        media_duration_seconds: 4.25,
        video_width_px: 5,
        video_height_px: 2,
        audio_sample_rate_hz: 8_000,
        audio_channel_count: 1,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-ogg-bos cache version', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'prefixed.ogg')
      const oggBuffer = Buffer.concat([
        createOggSkeletonBosPage(),
        ...createOggVorbisStreamPages({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(oggPath, oggBuffer)

      const cachePath = join(cacheDir(), `${fileHash(oggPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 19,
          nodes: [{ id: 'stale_ogg_audio', label: 'prefixed.ogg', file_type: 'audio', source_file: oggPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([oggPath])
      const oggNode = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'prefixed.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        file_bytes: oggBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-ogg-window cache version', () => {
    const root = createTempRoot()
    try {
      const oggPath = join(root, 'large-prefixed.ogg')
      const oggBuffer = Buffer.concat([
        ...createOggFillerPages(300_000, 29),
        ...createOggVorbisStreamPages({
          title: 'Release Notes',
          artist: 'Sadeem FM',
          album: 'Engineering Notes',
        }),
      ])
      writeFileSync(oggPath, oggBuffer)

      const cachePath = join(cacheDir(), `${fileHash(oggPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 20,
          nodes: [{ id: 'stale_large_prefixed_ogg_audio', label: 'large-prefixed.ogg', file_type: 'audio', source_file: oggPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([oggPath])
      const oggNode = recovered.nodes.find((node) => node.file_type === 'audio' && node.label === 'large-prefixed.ogg')

      expect(oggNode).toMatchObject({
        content_type: 'audio/ogg',
        file_bytes: oggBuffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 44100,
        audio_channel_count: 2,
        audio_title: 'Release Notes',
        audio_artist: 'Sadeem FM',
        audio_album: 'Engineering Notes',
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-mp4-video-audio cache version', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'clip.mp4')
      const mp4Buffer = createTestVideoMp4Buffer()
      writeFileSync(mp4Path, mp4Buffer)

      const cachePath = join(cacheDir(), `${fileHash(mp4Path)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 21,
          nodes: [{ id: 'stale_mp4_video', label: 'clip.mp4', file_type: 'video', source_file: mp4Path }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mp4Path])
      const mp4Node = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'clip.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached raw extractions from the pre-anonymous-default-export cache version', () => {
    const root = createTempRoot()
    try {
      const authPath = join(root, 'auth.ts')
      writeFileSync(
        authPath,
        [
          'export default function (userId: string) {',
          '  return `${userId}-session`',
          '}',
        ].join('\n'),
        'utf8',
      )

      const cachePath = join(cacheDir(), `${fileHash(authPath)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 59,
          nodes: [{ id: 'auth', label: 'auth.ts', file_type: 'code', source_file: authPath }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([authPath])
      const fileNodeId = recovered.nodes.find((node) => node.label === 'auth.ts')?.id
      const defaultExportId = recovered.nodes.find((node) => node.label === 'default()' && node.source_file === authPath)?.id

      expect(fileNodeId).toBeTruthy()
      expect(defaultExportId).toBeTruthy()
      expect(recovered.edges.some((edge) => edge.source === fileNodeId && edge.target === defaultExportId && edge.relation === 'contains')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-mp4-tkhd fallback cache version', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'tkhd-fallback.mp4')
      const mp4Buffer = createTestVideoMp4Buffer({ truncateVideoSampleEntry: true, includeVideoTkhdDimensions: true })
      writeFileSync(mp4Path, mp4Buffer)

      const cachePath = join(cacheDir(), `${fileHash(mp4Path)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 22,
          nodes: [{ id: 'stale_tkhd_fallback_video', label: 'tkhd-fallback.mp4', file_type: 'video', source_file: mp4Path }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mp4Path])
      const mp4Node = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'tkhd-fallback.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cached media extractions from the pre-mp4-mdhd fallback cache version', () => {
    const root = createTempRoot()
    try {
      const mp4Path = join(root, 'mdhd-fallback.mp4')
      const mp4Buffer = createTestVideoMp4Buffer({ omitMovieHeaderDuration: true, includeTrackMdhdDuration: true })
      writeFileSync(mp4Path, mp4Buffer)

      const cachePath = join(cacheDir(), `${fileHash(mp4Path)}.json`)
      writeFileSync(
        cachePath,
        JSON.stringify({
          __sadeemTsExtractorVersion: 23,
          nodes: [{ id: 'stale_mdhd_fallback_video', label: 'mdhd-fallback.mp4', file_type: 'video', source_file: mp4Path }],
          edges: [],
        }),
        'utf8',
      )

      const recovered = extract([mp4Path])
      const mp4Node = recovered.nodes.find((node) => node.file_type === 'video' && node.label === 'mdhd-fallback.mp4')

      expect(mp4Node).toMatchObject({
        content_type: 'video/mp4',
        file_bytes: mp4Buffer.length,
        media_duration_seconds: 2.5,
        audio_sample_rate_hz: 48000,
        audio_channel_count: 2,
        video_width_px: 1920,
        video_height_px: 1080,
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: 'builtin:extract:video', stage: 'extract' })],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not cache unsupported language placeholders', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.elm')
      writeFileSync(filePath, 'module Main exposing (main)\n', 'utf8')

      const result = extract([filePath])
      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)

      expect(result.nodes).toHaveLength(0)
      expect(result.edges).toHaveLength(0)
      expect(existsSync(cachePath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('React component classification', () => {
    it('tags uppercase JSX-returning function as node_kind: component in .tsx', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'Button.tsx')
        writeFileSync(
          filePath,
          ['function Button() {', '  return <div>click me</div>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const buttonNode = result.nodes.find((n) => n.label === 'Button()')
        expect(buttonNode).toBeTruthy()
        expect(buttonNode?.node_kind).toBe('component')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tags uppercase JSX-returning arrow function as node_kind: component in .tsx', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'Card.tsx')
        writeFileSync(
          filePath,
          ['const Card = () => {', '  return <span>card</span>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const cardNode = result.nodes.find((n) => n.label === 'Card()')
        expect(cardNode).toBeTruthy()
        expect(cardNode?.node_kind).toBe('component')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('does NOT tag lowercase function as component even when it returns JSX', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'helpers.tsx')
        writeFileSync(
          filePath,
          ['function helper() {', '  return <div>hi</div>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const helperNode = result.nodes.find((n) => n.label === 'helper()')
        expect(helperNode).toBeTruthy()
        expect(helperNode?.node_kind).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('does NOT tag non-JSX uppercase function as component', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'MyHelper.tsx')
        writeFileSync(
          filePath,
          ['function MyHelper() {', "  return 'hello'", '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const myHelperNode = result.nodes.find((n) => n.label === 'MyHelper()')
        expect(myHelperNode).toBeTruthy()
        expect(myHelperNode?.node_kind).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('does NOT tag uppercase JSX-returning function as component in a plain .ts file', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'Button.ts')
        writeFileSync(
          filePath,
          ['function Button() {', "  return 'not jsx'", '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const buttonNode = result.nodes.find((n) => n.label === 'Button()')
        expect(buttonNode).toBeTruthy()
        expect(buttonNode?.node_kind).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('emits renders edges for JSX component usage in .tsx', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'App.tsx')
        writeFileSync(
          filePath,
          ['function App() {', '  return <Button />', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const appNode = result.nodes.find((n) => n.label === 'App()')
        expect(appNode).toBeTruthy()
        expect(appNode?.node_kind).toBe('component')
        const rendersEdge = result.edges.find(
          (e) => e.source === appNode?.id && e.target === 'Button__jsx_proxy' && e.relation === 'renders',
        )
        expect(rendersEdge).toBeTruthy()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('emits renders edges for JSX element usage in .tsx', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'App.tsx')
        writeFileSync(
          filePath,
          ['function App() {', '  return <Header><Footer /></Header>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const appNode = result.nodes.find((n) => n.label === 'App()')
        expect(appNode).toBeTruthy()
        const rendersTargets = result.edges
          .filter((e) => e.source === appNode?.id && e.relation === 'renders')
          .map((e) => e.target)
        expect(rendersTargets).toContain('Header__jsx_proxy')
        expect(rendersTargets).toContain('Footer__jsx_proxy')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('does NOT emit renders edges for DOM elements (lowercase tags)', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'App.tsx')
        writeFileSync(
          filePath,
          ['function App() {', '  return <div><span>hi</span></div>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const appNode = result.nodes.find((n) => n.label === 'App()')
        expect(appNode).toBeTruthy()
        const rendersEdges = result.edges.filter((e) => e.source === appNode?.id && e.relation === 'renders')
        expect(rendersEdges).toHaveLength(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('deduplicates renders edges when same component used multiple times', () => {
      const root = createTempRoot()
      try {
        const filePath = join(root, 'App.tsx')
        writeFileSync(
          filePath,
          ['function App() {', '  return <div><Button /><Button /></div>', '}'].join('\n'),
          'utf8',
        )
        const result = extractJs(filePath)
        const appNode = result.nodes.find((n) => n.label === 'App()')
        expect(appNode).toBeTruthy()
        const rendersEdges = result.edges.filter(
          (e) => e.source === appNode?.id && e.relation === 'renders' && e.target === 'Button__jsx_proxy',
        )
        expect(rendersEdges).toHaveLength(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
