export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 4;
export const MAX_SIDE = 1568;
/** Four of these as base64 stay under the backend's 20 MiB total, and each is under the 5 MB the model accepts. */
export const TARGET_BYTES = 3_900_000;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
export const DEFAULT_QUESTION = "What is in this screenshot?";

/** What the backend takes with an ask. */
export interface ImageData {
  mediaType: string;
  data: string;
}

/** An image the person has attached, held in memory only. */
export interface PipImage extends ImageData {
  id: string;
  /** An object URL for showing it; revoked when it is removed. */
  url: string;
  width: number;
  height: number;
}

/** What a sent turn keeps of its images: enough to show them, not to send them again. */
export interface ShownImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export const defaultQuestion = (count: number) => (count > 1 ? "What is in these screenshots?" : DEFAULT_QUESTION);

export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The image type the first bytes say, whatever the browser called the file. */
export function sniffImageType(head: Uint8Array): string | null {
  const at = (offset: number, text: string) => [...text].every((c, i) => head[offset + i] === c.charCodeAt(0));
  if (head[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

/** The file with its type taken from its content, so an empty or odd type (`image/jpg`) doesn't turn a real image away. */
export async function withDetectedType(file: File): Promise<File> {
  const type = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  return type && type !== file.type ? new File([file], file.name, { type }) : file;
}

/** Why a file can't be attached, or null when it can. */
export function refusal(file: { type: string; size: number; name?: string }): string | null {
  const name = file.name ? `“${file.name}”` : "That file";
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return `${name} isn't an image Pip can look at. Use PNG, JPEG, GIF or WebP.`;
  if (file.size === 0) return `${name} is empty.`;
  if (file.size > MAX_SOURCE_BYTES) return `${name} is too large to attach.`;
  return null;
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

let seq = 0;

/** Scales a picture down to `MAX_SIDE` and re-encodes it until it fits `TARGET_BYTES`. */
export async function prepareImage(file: File): Promise<PipImage> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`“${file.name || "That file"}” couldn't be read as an image.`);
  try {
    let { width, height } = fitWithin(bitmap.width, bitmap.height);
    let blob: Blob = file;
    const resized = width !== bitmap.width || height !== bitmap.height;
    if (resized || file.size > TARGET_BYTES) {
      const canvas = document.createElement("canvas");
      const keepsAlpha = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
      let type = keepsAlpha ? "image/png" : "image/jpeg";
      let quality = 0.92;
      let encoded: Blob | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Couldn't prepare the image.");
        if (type === "image/jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        encoded = await encode(canvas, type, quality);
        if (encoded && encoded.size <= TARGET_BYTES) break;
        if (type === "image/png") type = "image/jpeg";
        else if (quality > 0.7) quality -= 0.1;
        else ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.8)));
      }
      if (!encoded || encoded.size > TARGET_BYTES) throw new Error(`“${file.name || "That image"}” is too large to attach, even scaled down.`);
      blob = encoded;
    }
    return { id: `img-${Date.now().toString(36)}-${++seq}`, mediaType: blob.type, data: await toBase64(blob), url: URL.createObjectURL(blob), width, height };
  } finally {
    bitmap.close();
  }
}
