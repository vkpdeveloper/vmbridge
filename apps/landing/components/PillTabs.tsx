"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { pill, pillActive } from "@/lib/styles";

interface PillItem {
  id: string;
  label: string;
  /** Extra content under the label of an item; vertical lists at `verticalAt` only. */
  detail?: React.ReactNode;
}

/**
 * Pills with one indicator that slides and resizes to the active pill, measuring
 * position and size so it also fits rows that wrap or items that grow. `vertical`
 * stacks full-width items from `verticalAt` up (`"always"` stacks at every width)
 * and falls back to the scrollable horizontal row below it; a vertical item may
 * carry `detail`, shown under its label while active, or on every item with
 * `showAllDetail`. The indicator only renders once measured, so first paint does
 * not animate from zero. `stagger` reveals the items one by one (60ms steps) the
 * first time the list enters the viewport.
 */
export function PillTabs({
  items,
  active,
  onChange,
  label,
  orientation = "horizontal",
  verticalAt = "xl",
  wrap = false,
  showAllDetail = false,
  stagger = false,
  itemClassName = "",
  indicatorClassName = "bg-muted",
}: {
  items: PillItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  orientation?: "horizontal" | "vertical";
  verticalAt?: "lg" | "xl" | "always";
  /** Wrap the horizontal row onto extra lines instead of scrolling sideways. */
  wrap?: boolean;
  /** Show every item's `detail`, not only the active one. */
  showAllDetail?: boolean;
  /** Reveal items child by child when the list first scrolls into view. */
  stagger?: boolean;
  itemClassName?: string;
  indicatorClassName?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const inView = useInView(list, "0px 0px -10% 0px");
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (inView) setSeen(true);
  }, [inView]);
  const shown = !stagger || reduced || seen;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const vertical = orientation === "vertical";
  // Static strings: Tailwind cannot scan dynamically built variants.
  const atList =
    verticalAt === "always"
      ? "flex-col overflow-visible"
      : verticalAt === "lg"
        ? "lg:flex-col lg:overflow-visible"
        : "xl:flex-col xl:overflow-visible";
  const atItem =
    verticalAt === "always" ? "w-full shrink text-left" : verticalAt === "lg" ? "lg:w-full lg:shrink lg:text-left" : "xl:w-full xl:shrink xl:text-left";
  const atDetail = verticalAt === "always" ? "block" : verticalAt === "lg" ? "hidden lg:block" : "hidden xl:block";

  const measure = useCallback(() => {
    const el = buttons.current.get(active);
    if (el) setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  }, [active]);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    buttons.current.forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      role="tablist"
      aria-label={label}
      ref={list}
      className={`relative flex gap-1 ${
        wrap ? "flex-wrap overflow-visible" : "flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      } ${vertical ? atList : ""}`}
    >
      {box ? (
        <span
          aria-hidden
          className={`absolute top-0 left-0 rounded-md transition-[transform,width,height] duration-200 ease-out ${indicatorClassName}`}
          style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
        />
      ) : null}
      {items.map((item, i) => {
        const current = item.id === active;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) buttons.current.set(item.id, el);
              else buttons.current.delete(item.id);
            }}
            type="button"
            role="tab"
            aria-selected={current}
            onClick={() => onChange(item.id)}
            style={stagger ? { transitionDelay: shown ? `${Math.min(i, 8) * 60}ms` : "0ms" } : undefined}
            className={`relative z-10 shrink-0 ${pill} ${current ? pillActive : ""} ${vertical ? atItem : ""} ${itemClassName} ${
              stagger ? `reveal ${shown ? "reveal-in" : ""}` : ""
            }`}
          >
            {item.label}
            {vertical && item.detail && (showAllDetail || current) ? <span className={`mt-2 font-sans ${atDetail}`}>{item.detail}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
