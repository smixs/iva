export type TelegramRawMessage = Record<string, unknown>;

function isTelegramRawMessage(value: unknown): value is TelegramRawMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TelegramRawMedia = {
  fileId: string;
  fileUniqueId?: string;
  tag: string;
  transcribe: boolean;
  mimeType?: string;
  fileName?: string;
};

const RAW_MEDIA: ReadonlyArray<{
  key: string;
  tag: string;
  transcribe: boolean;
}> = [
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
    const photos = raw.photo as unknown[];
    const photo = photos[photos.length - 1];
    if (
      typeof photo === "object" &&
      photo !== null &&
      !Array.isArray(photo) &&
      typeof (photo as Record<string, unknown>).file_id === "string"
    ) {
      const photoRecord = photo as Record<string, unknown>;
      return {
        fileId: photoRecord.file_id as string,
        ...(typeof photoRecord.file_unique_id === "string"
          ? { fileUniqueId: photoRecord.file_unique_id }
          : {}),
        tag: "photo",
        transcribe: false,
      };
    }
  }
  for (const media of RAW_MEDIA) {
    const item = raw[media.key] as
      | {
          file_id?: string;
          file_unique_id?: string;
          mime_type?: string;
          file_name?: string;
        }
      | undefined;
    if (item && typeof item.file_id === "string") {
      return {
        fileId: item.file_id,
        ...(typeof item.file_unique_id === "string"
          ? { fileUniqueId: item.file_unique_id }
          : {}),
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
  if (!Array.isArray(raw.iva_parts)) return [raw];

  const valid = raw.iva_parts.filter(isTelegramRawMessage);
  return valid.length > 0 ? valid : [raw];
}
