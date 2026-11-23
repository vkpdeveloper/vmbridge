"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { useSiteState } from "./SiteState";

const cursor = (blink: boolean) => (
  <span
    className="inline-block h-[1.1em] w-[0.55em] bg-primary align-text-bottom"
    style={blink ? { animation: "blink 1s steps(1) infinite" } : undefined}
  />
);

/** "  label   http://…" — the address table's two-column rows. */
const ADDRESS = /^ {2}(.+?)\s{2,}(https?:\/\/\S+)$/;

/** "command   description" — help output's aligned rows. */
const COLUMNS = /^(\S.*?)\s{2,}(\S.*)$/;

/** The label width a set of output lines needs so second columns align. */
export function labelWidth(lines: string[]): number {
  let width = 0;
  for (const text of lines) {
    const match = ADDRESS.exec(text) ?? COLUMNS.exec(text);
    if (match) width = Math.max(width, match[1].length);
  }
  return width;
}

/**
 * A URL that wraps only after a `/`. Each segment is `nowrap` — otherwise a hyphen
 * inside a host name is a soft wrap point (`your-|mac`) — and a `<wbr />` after every
 * `/` marks the legal cuts, so a wrapped URL ends each line on a slash. `anywhere`
 * stays declared as the last resort, but nowrap blocks it: an oversized segment
 * overflows rather than splits (measured max segment 245px vs the narrowest column
 * 278px at 390px, so it never triggers on this page).
 */
export function UrlText({ url }: { url: string }) {
  const segments = url.split(/(?<=\/)/);
  return (
    <span data-url className="[overflow-wrap:anywhere]">
      {segments.map((segment, i) => (
        <Fragment key={i}>
          <span className="whitespace-nowrap">{segment}</span>
          {i < segments.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * One terminal output line. `$ ` commands echo as-is. Address-table and help rows lay out in
 * two columns with a shared label width (`labelWidth`, in ch); the value column wraps or breaks
 * so nothing scrolls sideways. Every other line wraps with a hanging indent. `className` carries
 * the caller's row styling (min-height for blank lines).
 */
export function TerminalLine({ text, labels = 0, className = "" }: { text: string; labels?: number; className?: string }) {
  if (text.startsWith("$")) {
    return (
      <div className={`[overflow-wrap:anywhere] ${className}`}>
        <span className="text-faint">$</span> {text.slice(2)}
      </div>
    );
  }
  const address = ADDRESS.exec(text);
  if (address) {
    return (
      <div className={`grid grid-cols-1 pl-[2ch] text-muted-foreground sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-2 ${className}`}>
        <span style={labels ? { minWidth: `${labels}ch` } : undefined}>{address[1]}</span>
        <span className="pl-[2ch] [overflow-wrap:anywhere] sm:pl-0">
          <UrlText url={address[2]} />
        </span>
      </div>
    );
  }
  const columns = COLUMNS.exec(text);
  if (columns) {
    return (
      <div className={`grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 pl-[2ch] text-muted-foreground ${className}`}>
        <span style={labels ? { minWidth: `${labels}ch` } : undefined}>{columns[1]}</span>
        <span className="min-w-0">{columns[2]}</span>
      </div>
    );
  }
  return <div className={`pl-[2ch] -indent-[2ch] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere] ${className}`}>{text}</div>;
}

/** A static transcript for `noscript`, rendered with the same line renderer. */
export function TerminalTranscript({ script, className = "" }: { script: string[]; className?: string }) {
  const labels = labelWidth(script);
  return (
    <>
      {script.map((text, i) => (
        <TerminalLine key={i} text={text} labels={labels} className={className} />
      ))}
    </>
  );
}

/**
 * The body of a terminal: plays a script once it scrolls into view. `$ ` commands type character by
 * character, the other lines print one by one, and a cursor waits on a fresh prompt at the end.
 * Callers wrap it in a `Panel`. `rows` pins the height to the longest script in a set so switching
 * scripts does not jump. Without JS the `noscript` transcript renders the whole script and the live
 * area hides, so nothing sits empty.
 */
export function TerminalBody({ script, rows, className = "" }: { script: string[]; rows?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Latched, so a script that has started keeps its place when it scrolls out and back in.
  const [inView, setInView] = useState(false);
  const onScreen = useInView(ref);
  useEffect(() => {
    if (onScreen) setInView(true);
  }, [onScreen]);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const [visible, setVisible] = useState(0);
  const [typed, setTyped] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setVisible(0);
    setTyped(0);
    setDone(false);
    if (reduced) {
      setVisible(script.length);
      setDone(true);
      return;
    }
    if (!inView) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    script.forEach((line, index) => {
      if (line.startsWith("$ ")) {
        const length = line.length - 2;
        for (let i = 1; i <= length; i++) {
          at += 28;
          const count = i;
          timers.push(setTimeout(() => setTyped(count), at));
        }
        at += 250;
        timers.push(
          setTimeout(() => {
            setVisible(index + 1);
            setTyped(0);
          }, at),
        );
      } else {
        at += 70;
        timers.push(setTimeout(() => setVisible(index + 1), at));
      }
    });
    timers.push(setTimeout(() => setDone(true), at + 100));
    return () => timers.forEach(clearTimeout);
  }, [script, inView, reduced]);

  const lineCount = (rows ?? script.length) + 1;
  const line = "min-h-6 sm:min-h-7";
  const labels = labelWidth(script);
  return (
    <div
      ref={ref}
      data-terminal-output
      className={`p-5 font-mono text-[12px] leading-6 break-words whitespace-pre-wrap sm:p-6 sm:text-[13px] sm:leading-7 ${className}`}
      style={{ minHeight: `${Math.max(11, lineCount * 1.75 + 5)}rem` }}
    >
      <noscript>
        <TerminalTranscript script={script} className={line} />
      </noscript>
      <div className="[html:not(.js)_&]:hidden">
        {script.slice(0, visible).map((text, i) => (
          <TerminalLine key={i} text={text} labels={labels} className={line} />
        ))}
        {!done && visible < script.length && script[visible].startsWith("$ ") ? (
          <div className={line}>
            <span className="text-faint">$</span> {script[visible].slice(2, 2 + typed)}
            {cursor(phase !== "asleep")}
          </div>
        ) : null}
        {done ? (
          <div className={line}>
            <span className="text-faint">$</span> {cursor(!reduced && phase !== "asleep")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
