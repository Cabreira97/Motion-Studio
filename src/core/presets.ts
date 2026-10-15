import type { Framing, Size } from "./types.js";

export interface ExportPreset {
  id: string;
  label: string;
  container: string;
  extension: string;
  /** Preferred canvas height; output size is derived from the source aspect. */
  maxHeight: number;
  videoCodec: string;
  qualityFlag: string;
  qualityValue: string;
  speedFlag: string;
  speedValue: string;
  pixelFormat: string;
  audioCodec: string;
  audioBitrate: string;
  extraVideoArgs: string[];
  extraContainerArgs: string[];
}

/**
 * Sensible local-first presets. H.264/MP4 is the compatibility default,
 * VP9/WebM is offered for open formats. Everything runs through the locally
 * installed ffmpeg — no cloud rendering.
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: "mp4-1080p",
    label: "MP4 · H.264 · 1080p",
    container: "mp4",
    extension: "mp4",
    maxHeight: 1080,
    videoCodec: "libx264",
    qualityFlag: "-crf",
    qualityValue: "20",
    speedFlag: "-preset",
    speedValue: "medium",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "192k",
    extraVideoArgs: ["-profile:v", "high", "-level", "4.1"],
    extraContainerArgs: ["-movflags", "+faststart"],
  },
  {
    id: "mp4-720p",
    label: "MP4 · H.264 · 720p",
    container: "mp4",
    extension: "mp4",
    maxHeight: 720,
    videoCodec: "libx264",
    qualityFlag: "-crf",
    qualityValue: "22",
    speedFlag: "-preset",
    speedValue: "veryfast",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "160k",
    extraVideoArgs: [],
    extraContainerArgs: ["-movflags", "+faststart"],
  },
  {
    id: "webm-vp9",
    label: "WebM · VP9 · 1080p",
    container: "webm",
    extension: "webm",
    maxHeight: 1080,
    videoCodec: "libvpx-vp9",
    qualityFlag: "-crf",
    qualityValue: "32",
    speedFlag: "-deadline",
    speedValue: "good",
    pixelFormat: "yuv420p",
    audioCodec: "libopus",
    audioBitrate: "160k",
    extraVideoArgs: ["-b:v", "0", "-row-mt", "1"],
    extraContainerArgs: [],
  },
  {
    id: "webm-vp9-720p",
    label: "WebM · VP9 · 720p",
    container: "webm",
    extension: "webm",
    maxHeight: 720,
    videoCodec: "libvpx-vp9",
    qualityFlag: "-crf",
    qualityValue: "34",
    speedFlag: "-deadline",
    speedValue: "realtime",
    pixelFormat: "yuv420p",
    audioCodec: "libopus",
    audioBitrate: "128k",
    extraVideoArgs: ["-b:v", "0", "-row-mt", "1"],
    extraContainerArgs: [],
  },
];

export const DEFAULT_PRESET_ID = "mp4-1080p";

export function getPreset(id: string): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[0]!;
}

/** Forces even dimensions (required by most encoders). */
export function evenSize(size: Size): Size {
  const width = Math.max(2, Math.round(size.width / 2) * 2);
  const height = Math.max(2, Math.round(size.height / 2) * 2);
  return { width, height };
}

/**
 * Derives the concrete export resolution from the framing canvas and the
 * preset cap, preserving the canvas aspect ratio.
 */
export function resolveOutputSize(framing: Framing, preset: ExportPreset): Size {
  const aspect = framing.outputWidth / framing.outputHeight;
  if (framing.outputHeight <= preset.maxHeight) {
    return evenSize({ width: framing.outputWidth, height: framing.outputHeight });
  }
  const height = preset.maxHeight;
  return evenSize({ width: Math.round(height * aspect), height });
}

/** Container/codec args for a preset (used by the planner and Rust mirror). */
export function presetCodecArgs(preset: ExportPreset, hasAudio: boolean): string[] {
  const args = [
    "-c:v",
    preset.videoCodec,
    preset.qualityFlag,
    preset.qualityValue,
    preset.speedFlag,
    preset.speedValue,
    "-pix_fmt",
    preset.pixelFormat,
    ...preset.extraVideoArgs,
  ];
  if (hasAudio) {
    args.push("-c:a", preset.audioCodec, "-b:a", preset.audioBitrate);
  } else {
    args.push("-an");
  }
  args.push(...preset.extraContainerArgs);
  return args;
}
