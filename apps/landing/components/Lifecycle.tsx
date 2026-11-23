"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { useReducedMotion } from "@/lib/hooks";
import { Reveal } from "./Reveal";
import { Section } from "./Section";
import { stateDot } from "./Topology";
import { Panel } from "./Window";

type Phase = "asleep" | "waking" | "online" | "idle";

type Item =
  | { id: number; kind: "user"; text: string; animate: boolean }
  | { id: number; kind: "agent"; text: string; animate: boolean }
  | { id: number; kind: "notice"; text: string; dot: string; animate: boolean };

const markers = [
  "size-2.5 rounded-full bg-primary",
  "size-2.5 rounded-full ring-1 ring-primary",
  "size-2.5 rounded-full ring-1 ring-white/40",
  "size-2.5 animate-pulse rounded-full bg-primary",
];

const phaseIndex: Record<Phase, number> = { online: 0, idle: 1, asleep: 2, waking: 3 };

const chipDot: Record<Phase, string> = {
  online: stateDot.online,
  waking: stateDot.waking,
  asleep: stateDot.asleep,
  idle: "size-1.5 rounded-full ring-1 ring-primary",
};

const chipLabel = (phase: Phase) => (phase === "idle" ? copy.lifecycle.states[1].name : copy.diagram[phase]);

const exchanges = copy.demo.exchanges;

const initialItems: Item[] = [
  { id: 0, kind: "user", text: exchanges[0].message, animate: false },
  { id: 1, kind: "agent", text: exchanges[0].reply, animate: false },
  { id: 2, kind: "user", text: exchanges[1].message, animate: false },
  { id: 3, kind: "agent", text: exchanges[1].reply, animate: false },
  { id: 4, kind: "notice", text: copy.demo.asleep, dot: stateDot.asleep, animate: false },
];

const rise = { animation: "rise 200ms both" };

/**
 * A small T3 Code thread that demonstrates the VM lifecycle: Send wakes a sleeping VM, the agent
 * streams a reply, and after a few idle seconds the VM sleeps again. The section's left column
 * lists the four states with the live state's body under the list — the bodies share one grid
 * cell, so the column never jumps when the phase changes. The VM chip rides in the thread's
 * title strip.
 */
export function Lifecycle() {
  const [phase, setPhase] = useState<Phase>("asleep");
  const [index, setIndex] = useState(2);
  const [streaming, setStreaming] = useState(false);
  const [items, setItems] = useState<Item[]>(initialItems);
  const nextId = useRef(initialItems.length);
  const scroller = useRef<HTMLDivElement>(null);
  // Follows the newest message unless the visitor has scrolled back.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = (item: Item) => setItems((list) => [...list, item].slice(-6));

  const streamReply = (reply: string) => {
    setStreaming(true);
    const finish = () => {
      setStreaming(false);
      setPhase("idle");
      idleTimer.current = setTimeout(() => {
        setPhase("asleep");
        push({ id: nextId.current++, kind: "notice", text: copy.demo.asleep, dot: stateDot.asleep, animate: true });
      }, 8000);
      timers.current.push(idleTimer.current);
    };
    if (reduced) {
      push({ id: nextId.current++, kind: "agent", text: reply, animate: true });
      finish();
      return;
    }
    const id = nextId.current++;
    const words = reply.split(" ");
    push({ id, kind: "agent", text: "", animate: true });
    words.forEach((_, w) => {
      timers.current.push(
        setTimeout(() => {
          setItems((list) => list.map((item) => (item.id === id ? { ...item, text: words.slice(0, w + 1).join(" ") } : item)));
        }, (w + 1) * 45),
      );
    });
    timers.current.push(setTimeout(finish, words.length * 45 + 120));
  };

  const send = () => {
    if (phase === "waking" || streaming) return;
    // Busy from now until the reply finishes, so a second Send cannot slip in before it starts.
    setStreaming(true);
    const exchange = exchanges[index % exchanges.length];
    setIndex((index + 1) % exchanges.length);
    push({ id: nextId.current++, kind: "user", text: exchange.message, animate: true });
    const wasAsleep = phase === "asleep";
    if (wasAsleep) {
      setPhase("waking");
      push({ id: nextId.current++, kind: "notice", text: `${copy.demo.waking} vm-df9bca`, dot: stateDot.waking, animate: true });
      timers.current.push(setTimeout(() => setPhase("online"), 1600));
    } else {
      setPhase("online");
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    }
    timers.current.push(setTimeout(() => streamReply(exchange.reply), wasAsleep ? 1800 : 300));
  };

  const message = exchanges[index % exchanges.length].message;
  const current = phaseIndex[phase];

  return (
    <Section
      id="lifecycle"
      title={copy.lifecycle.title}
      body={copy.lifecycle.body}
      splitAt="lg"
      side={
        <>
          <div className="flex flex-col">
            {copy.lifecycle.states.map((state, i) => (
              <Reveal key={state.name} delay={i * 60}>
                <div
                  aria-current={i === current || undefined}
                  className={`-mx-3 flex items-center gap-3 rounded-lg px-3 py-1.5 text-lg font-medium transition-colors duration-200 ${
                    i === current ? "bg-muted" : "text-faint"
                  }`}
                >
                  <span className={`shrink-0 transition-all duration-200 ${markers[i]}`} />
                  {state.name}
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-6 grid">
            {copy.lifecycle.states.map((state, i) => (
              <p
                key={state.name}
                aria-hidden={i !== current || undefined}
                className={`col-start-1 row-start-1 text-pretty text-base leading-relaxed text-muted-foreground ${i === current ? "" : "invisible"}`}
                style={i === current ? rise : undefined}
              >
                {state.body}
              </p>
            ))}
          </div>
        </>
      }
    >
      <Panel
        className="flex w-full flex-col"
        label="t3 code / Hello-World"
        aside={
          <span className="flex h-7 items-center gap-1.5 rounded-md bg-muted px-2.5 whitespace-nowrap text-muted-foreground">
            <span className={`transition-all duration-200 ${chipDot[phase]}`} />
            <span className="hidden sm:inline">vm-df9bca</span>
            <span className="transition-colors duration-200">{chipLabel(phase)}</span>
          </span>
        }
      >
        {phase === "idle" ? <div className="h-px origin-left bg-primary" style={{ animation: "drain 8000ms linear forwards" }} /> : null}
        <div className="flex h-[30rem] flex-col sm:h-[27rem]">
          {/* Scrolls when the transcript outgrows the pane (narrow phones). The inner column
              pushes short transcripts to the bottom without putting overflow above the scroll origin. */}
          <div
            ref={scroller}
            data-lenis-prevent
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="min-h-0 flex-1 basis-0 overflow-y-auto overscroll-y-auto! p-5 [mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)] sm:p-6"
          >
            <div className="flex min-h-full flex-col justify-end gap-5">
            {items.map((item) =>
              item.kind === "user" ? (
                <div key={item.id} className="ml-auto max-w-[80%] rounded-md bg-muted px-3.5 py-2 text-base" style={item.animate ? rise : undefined}>
                  {item.text}
                </div>
              ) : item.kind === "agent" ? (
                <div key={item.id} className="max-w-[85%] text-pretty text-base text-muted-foreground" style={item.animate ? rise : undefined}>
                  {item.text}
                </div>
              ) : (
                <div key={item.id} className="flex items-baseline justify-center gap-2 text-center font-mono text-[13px] text-balance text-faint" style={item.animate ? rise : undefined}>
                  <span className={item.dot} />
                  {item.text}
                </div>
              ),
            )}
            </div>
          </div>
          <div className="mx-5 mt-0 mb-5 flex items-end gap-2 rounded-md bg-muted py-2 pr-1.5 pl-3.5 sm:mx-6 sm:mb-6">
            <span aria-hidden className="line-clamp-2 flex-1 text-base leading-6 text-muted-foreground">
              {message}
            </span>
            <button
              type="button"
              onClick={send}
              disabled={phase === "waking" || streaming}
              aria-label={`${copy.demo.send}: ${message}`}
              className="inline-flex h-8 shrink-0 items-center self-end rounded-md bg-white px-3 font-mono text-[13px] text-black transition-[color,background-color,transform] duration-150 hover:bg-white/85 active:bg-white/70 active:scale-[0.97] disabled:opacity-40"
            >
              {copy.demo.send}
            </button>
          </div>
        </div>
      </Panel>
    </Section>
  );
}
