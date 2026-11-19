"use client";

import { cloneElement, Fragment, isValidElement, useRef, useState, type AudioHTMLAttributes } from "react";
import type { Components } from "react-markdown";

import { normalizeMediaSrc } from "@/lib/media";

type AudioPlayerProps = {
  src: string;
  className?: string;
  audioProps?: Omit<AudioHTMLAttributes<HTMLAudioElement>, "src">;
};

function formatAudioTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clampAudioTime(value: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, value);
  }

  return Math.min(Math.max(0, value), duration);
}

export function AudioPlayer({ src, className = "", audioProps }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const syncCurrentTime = () => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    setCurrentTime(audio.currentTime);
  };

  const syncDuration = () => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const nextDuration = Number.isFinite(audio.duration) ? audio.duration : 0;

    setDuration(nextDuration);
    setCurrentTime((value) => clampAudioTime(value, nextDuration));
  };

  const seekBy = (offset: number) => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const boundedValue = clampAudioTime(audio.currentTime + offset, safeDuration);
    audio.currentTime = boundedValue;
    setCurrentTime(boundedValue);
  };

  return (
    <div className={`customAudioPlayer ${className}`.trim()}>
      <div className="audioPlayerHeader">
        <span className="audioPlayerEyebrow">Audio</span>
        <span className="audioPlayerTime">
          {formatAudioTime(currentTime)} / {safeDuration ? formatAudioTime(safeDuration) : "--:--"}
        </span>
      </div>

      <audio
        {...audioProps}
        ref={audioRef}
        className="audioPlayerNative"
        controls
        preload="metadata"
        src={src}
        onTimeUpdate={syncCurrentTime}
        onLoadedMetadata={syncDuration}
        onDurationChange={syncDuration}
        onSeeked={syncCurrentTime}
      />

      <div className="audioPlayerControls">
        <button type="button" className="audioPlayerButton" onClick={() => seekBy(-10)} disabled={!safeDuration}>
          -10s
        </button>

        <button type="button" className="audioPlayerButton" onClick={() => seekBy(10)} disabled={!safeDuration}>
          +10s
        </button>
      </div>
    </div>
  );
}

export const markdownContentComponents: Components = {
  a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  img: ({ alt, src }) => {
    if (typeof src !== "string" || !src) {
      return null;
    }

    const resolvedSrc = normalizeMediaSrc(String(src));

    // eslint-disable-next-line @next/next/no-img-element
    return <img className="articleImage" src={resolvedSrc} alt={alt || "Imagen de la obra"} />;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  audio: ({ src, node, ...props }) => {
    if (typeof src !== "string" || !src) {
      return null;
    }

    const resolvedSrc = normalizeMediaSrc(String(src));

    return <AudioPlayer className="articleAudio" src={resolvedSrc} audioProps={props} />;
  },
  table: ({ children }) => (
    <section className="markdownTableWrap" aria-label="Tabla del contenido">
      <table className="markdownTable">{children}</table>
    </section>
  ),
  thead: ({ children }) => <thead className="markdownTableHead">{children}</thead>,
  tbody: ({ children }) => <tbody className="markdownTableBody">{children}</tbody>,
  tr: ({ children }) => <tr className="markdownTableRow">{children}</tr>,
  th: ({ children }) => <th className="markdownTableHeaderCell">{children}</th>,
  td: ({ children }) => <td className="markdownTableCell">{children}</td>,
};

type ParagraphKind = "line" | "direction" | "cue" | "pending" | "plain";

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function elementType(node: unknown) {
  return node && typeof node === "object" && "type" in node ? (node as { type: unknown }).type : null;
}

/** Classifies a script paragraph: **PERSONAJE:** line, *(acotación)*, **[PISTA]** cue or plain prose. */
function classifyParagraph(children: React.ReactNode): ParagraphKind {
  const items = (Array.isArray(children) ? children : [children]).filter(
    (child) => !(typeof child === "string" && !child.trim()),
  );
  const first = items[0];
  const firstText = textOf(first).trim();

  if (elementType(first) === "strong" || /^\[/.test(firstText) || /:$/.test(firstText)) {
    if (/^\[[^\]]+\]$/.test(firstText)) return "cue";
    if (/:$/.test(firstText) && firstText.length <= 40) return "line";
  }

  if (items.length === 1 && elementType(first) === "em") {
    return /^🔊/u.test(firstText) ? "pending" : "direction";
  }

  return "plain";
}

/** Headless Chrome has no emoji font: drop the 🔊 glyph (an SVG icon replaces it). */
function stripSpeakerEmoji(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return node.replace(/🔊\uFE0F?\s*/gu, "");
  if (Array.isArray(node)) return node.map((child, index) => <Fragment key={index}>{stripSpeakerEmoji(child)}</Fragment>);
  if (isValidElement<{ children?: React.ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(node, undefined, stripSpeakerEmoji(node.props.children));
  }
  return node;
}

/** Static, print-friendly variant: no audio controls, script paragraphs get semantic classes. */
export const printMarkdownComponents: Components = {
  ...markdownContentComponents,
  a: ({ children, href }) => <a href={href}>{children}</a>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  p: ({ children, node }) => {
    const kind = classifyParagraph(children);
    return (
      <p className={kind === "plain" ? undefined : `print-${kind}`}>
        {kind === "pending" ? <span className="print-icon" aria-hidden="true" /> : null}
        {stripSpeakerEmoji(children)}
      </p>
    );
  },
  audio: ({ src }) => {
    const name = typeof src === "string" ? decodeURIComponent(src.split("/").pop() || "").replace(/^\d+-/, "") : "";
    return (
      <span className="print-audio">
        <span className="print-icon" aria-hidden="true" />
        Audio{name ? `: ${name}` : ""}
      </span>
    );
  },
};
