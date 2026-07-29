export type TelegramRawMessage = Record<string, any>;

export type TelegramRawMedia = {
  fileId: string;
  tag: string;
  transcribe: boolean;
  mimeType?: string;
  fileName?: string;
};

const RAW_MEDIA: ReadonlyArray<{ key: string; tag: string; transcribe: boolean }> = [
  { key: "voice", tag: "voice", transcribe: true },
  { key: "audio", tag: "audio", transcribe: true },
  { key: "video", tag: "video", transcribe: true },
  { key: "video_note", tag: "video", transcribe: true },
  { key: "animation", tag: "animation", transcribe: false },
  { key: "sticker", tag: "sticker", transcribe: false },
  { key: "document", tag: "document", transcribe: false },
];

export function mediaFromRaw(raw: TelegramRawMessage): TelegramRawMedia | null {
  if (Array.isArray(raw.photo) && raw.photo.length > 0) {
    const photo = raw.photo[raw.photo.length - 1];
    if (photo?.file_id) {
      return { fileId: photo.file_id, tag: "photo", transcribe: false };
    }
  }
  for (const media of RAW_MEDIA) {
    const item = raw[media.key] as
      | { file_id?: string; mime_type?: string; file_name?: string }
      | undefined;
    if (item && typeof item.file_id === "string") {
      return {
        fileId: item.file_id,
        tag: media.tag,
        transcribe: media.transcribe,
        mimeType: item.mime_type,
        fileName: item.file_name,
      };
    }
  }
  return null;
}

export function messageParts(raw: TelegramRawMessage): TelegramRawMessage[] {
  return Array.isArray(raw.iva_parts) ? raw.iva_parts : [raw];
}
