import { useEffect, useRef, useState } from "react";
import { filesIn } from "../lib/attachments";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGES, prepareImage, refusal, type PipImage, type ShownImage } from "../lib/pipImages";
import { messageOf, useToasts } from "./toasts";

const LIGHTBOX_ATTR = "data-pip-lightbox";
export const lightboxOpen = () => document.querySelector(`[${LIGHTBOX_ATTR}]`) !== null;

/** The pictures attached to the question being written. They exist only in memory. */
export function useAttachments() {
  const [images, setImages] = useState<PipImage[]>([]);
  const held = useRef<PipImage[]>([]);
  const pending = useRef(0);
  held.current = images;

  useEffect(() => () => held.current.forEach((i) => URL.revokeObjectURL(i.url)), []);

  const add = async (files: File[]) => {
    const toasts = useToasts.getState();
    const room = MAX_IMAGES - held.current.length - pending.current;
    const usable = files.filter((f) => {
      const why = refusal(f);
      if (why) toasts.push(why);
      return !why;
    });
    if (usable.length > room) toasts.push(`Pip can look at up to ${MAX_IMAGES} images per message.`);
    pending.current += Math.min(usable.length, Math.max(room, 0));
    for (const file of usable.slice(0, Math.max(room, 0))) {
      try {
        const image = await prepareImage(file);
        setImages((all) => [...all, image]);
      } catch (e) {
        toasts.push(messageOf(e));
      } finally {
        pending.current -= 1;
      }
    }
  };

  const remove = (id: string) => {
    held.current.filter((i) => i.id === id).forEach((i) => URL.revokeObjectURL(i.url));
    setImages((all) => all.filter((i) => i.id !== id));
  };

  /** Hands the images over to a sent turn, which keeps showing them, so their URLs stay alive. */
  const take = () => {
    const taken = held.current;
    setImages([]);
    return taken;
  };

  return { images, add, remove, take };
}

export function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach an image"
        title={disabled ? `Up to ${MAX_IMAGES} images` : "Attach an image (or paste or drop one)"}
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="grid size-8 shrink-0 place-items-center self-center rounded-md border border-ws-sep2 text-ws-ink2 hover:border-ws-pip hover:text-ws-pip disabled:opacity-45"
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <circle cx="6" cy="7" r="1.1" />
          <path d="m3 12 3.5-3 2.5 2 2-1.5L14 12" />
        </svg>
      </button>
    </>
  );
}

export function Thumb({ image, onOpen, onRemove, size = 56 }: { image: ShownImage; onOpen(): void; onRemove?: () => void; size?: number }) {
  return (
    <li className="relative list-none">
      <button type="button" onClick={onOpen} aria-label="View image larger" className="block overflow-hidden rounded-md border border-ws-sep2 hover:border-ws-pip" style={{ width: size, height: size }}>
        <img src={image.url} alt="" draggable={false} className="size-full object-cover" />
      </button>
      {onRemove && (
        <button type="button" aria-label="Remove image" onClick={onRemove} className="absolute -top-1.5 -right-1.5 grid size-4.5 place-items-center rounded-full border border-ws-sep2 bg-ws-win text-sm leading-none text-ws-ink2 hover:border-ws-blocked hover:text-ws-blocked">
          ×
        </button>
      )}
    </li>
  );
}

/** Thumbnails above the input, one removable each. */
export function AttachedThumbs({ images, onRemove }: { images: PipImage[]; onRemove(id: string): void }) {
  const [shown, setShown] = useState<ShownImage | null>(null);
  if (!images.length) return null;
  return (
    <>
      <ul aria-label="Attached images" className="m-0 flex flex-wrap gap-2 px-3 pt-2.5 pb-0">
        {images.map((i) => (
          <Thumb key={i.id} image={i} onOpen={() => setShown(i)} onRemove={() => onRemove(i.id)} />
        ))}
      </ul>
      {shown && <Lightbox image={shown} onClose={() => setShown(null)} />}
    </>
  );
}

/** The images a sent question carried, inside the conversation. */
export function TurnImages({ images }: { images: ShownImage[] }) {
  const [shown, setShown] = useState<ShownImage | null>(null);
  return (
    <>
      <ul aria-label="Images sent" className="m-0 flex max-w-[85%] flex-wrap justify-end gap-1.5 justify-self-end p-0">
        {images.map((i) => (
          <Thumb key={i.id} image={i} size={72} onOpen={() => setShown(i)} />
        ))}
      </ul>
      {shown && <Lightbox image={shown} onClose={() => setShown(null)} />}
    </>
  );
}

export function Lightbox({ image, onClose }: { image: ShownImage; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    close.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);
  return (
    <div {...{ [LIGHTBOX_ATTR]: "" }} role="dialog" aria-modal="true" aria-label="Image" onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
      <img src={image.url} alt="Attached screenshot" onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-lg bg-ws-win object-contain shadow-ws-pop" />
      <button ref={close} type="button" aria-label="Close image" onClick={onClose} className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-ws-win text-xl leading-none text-ws-ink shadow-ws-pop">
        ×
      </button>
    </div>
  );
}

/** Tracks a file drag over the pane so it can show where to drop. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    over,
    handlers: {
      onDragOver(e: React.DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop(e: React.DragEvent) {
        setOver(false);
        const files = filesIn(e.dataTransfer);
        if (!files.length) return;
        e.preventDefault();
        onFiles(files);
      },
    },
  };
}
