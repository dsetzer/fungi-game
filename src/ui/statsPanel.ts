import { SIM_HZ } from "../config";
import type { PlayerStats, Series } from "../sim/stats";
import type { PlayerId } from "../sim/types";

/**
 * The stats panel: graphs over the match and a table of totals. Shown at the end
 * of a game (lost, won, left, or an online round over) and, live and docked to
 * the side, while spectating.
 */

export interface StatsPlayer {
  id: PlayerId;
  name: string;
  color: string;
  alive: boolean;
  score: number;
}

export interface StatsData {
  stats: Map<PlayerId, PlayerStats>;
  players: StatsPlayer[];
  /** Whose panel this is; null for a spectator. */
  me: PlayerId | null;
  /** Solo ranks by who lasted longest; online rounds by who gathered the most. */
  rankBy: "survival" | "score";
}

export interface StatsAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

/** "you" is your own nutrients in and out; the rest compare every player. */
export type StatsTab = "you" | "held" | "colonies" | "income" | "lost" | "spent";

export interface StatsOptions {
  title: string;
  subtitle?: string;
  /** Re-read on every refresh, so a live view stays current. */
  data: () => StatsData;
  tabs: StatsTab[];
  actions: StatsAction[];
  /** Docked to the side, leaving the arena in view (spectating). */
  docked?: boolean;
}

const TAB_NAMES: Record<StatsTab, string> = {
  you: "Your flows",
  held: "Nutrients held",
  colonies: "Colonies",
  income: "Income /s",
  lost: "Lost to rivals /s",
  spent: "Spent /s",
};

/** The flows in "Your flows": in above, out below in warm colours. */
const FLOWS: { key: Series; label: string; color: string }[] = [
  { key: "gathered", label: "Gathered", color: "#2f9e44" },
  { key: "drained", label: "Drained from rivals", color: "#1971c2" },
  { key: "spent", label: "Spent", color: "#e8590c" },
  { key: "lost", label: "Lost to rivals", color: "#c92a2a" },
];

/** Rates are averaged over this many seconds, so a single tick's spike doesn't dominate. */
const RATE_WINDOW = 5;
/** Samples further apart than this are not joined (a gap in the record). */
const GAP_SECONDS = 2.5;

interface Line {
  label: string;
  color: string;
  t: number[];
  v: number[];
}

export class StatsPanel {
  private opts: StatsOptions | null = null;
  private tab: StatsTab = "you";
  private hoverT: number | null = null;
  private lines: Line[] = [];
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly table: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly actions: HTMLElement;

  constructor(private readonly el: HTMLElement) {
    el.hidden = true;
    el.innerHTML = `
      <header><h2></h2><small></small></header>
      <nav class="tabs"></nav>
      <canvas></canvas>
      <div class="legend"></div>
      <div class="table"></div>
      <p class="footer"></p>
      <div class="actions"></div>`;
    this.title = el.querySelector("h2")!;
    this.subtitle = el.querySelector("header small")!;
    this.tabs = el.querySelector(".tabs")!;
    this.canvas = el.querySelector("canvas")!;
    this.legend = el.querySelector(".legend")!;
    this.table = el.querySelector(".table")!;
    this.footer = el.querySelector(".footer")!;
    this.actions = el.querySelector(".actions")!;

    this.tabs.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest("button")?.dataset.tab as StatsTab | undefined;
      if (tab) {
        this.tab = tab;
        this.refresh();
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      this.hoverT = this.timeAt(e.offsetX);
      this.drawChart();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.hoverT = null;
      this.drawChart();
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(opts: StatsOptions): void {
    this.opts = opts;
    this.tab = opts.tabs[0];
    this.hoverT = null;
    this.el.hidden = false;
    this.el.classList.toggle("docked", !!opts.docked);
    this.title.textContent = opts.title;
    this.subtitle.textContent = opts.subtitle ?? "";
    this.subtitle.hidden = !opts.subtitle;
    this.tabs.innerHTML = opts.tabs.map((t) => `<button type="button" data-tab="${t}">${TAB_NAMES[t]}</button>`).join("");
    this.tabs.hidden = opts.tabs.length < 2;
    this.actions.replaceChildren(
      ...opts.actions.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        if (a.primary) b.className = "primary";
        b.addEventListener("click", a.run);
        return b;
      }),
    );
    this.actions.hidden = opts.actions.length === 0;
    this.refresh();
  }

  hide(): void {
    this.el.hidden = true;
    this.opts = null;
  }

  /** Re-reads the data and redraws; a live view calls this every second or so. */
  refresh(): void {
    if (!this.opts) return;
    const data = this.opts.data();
    for (const b of this.tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === this.tab);
    this.lines = this.linesFor(data);
    this.drawChart();
    this.table.innerHTML = tableHtml(data);
    this.footer.innerHTML = footerHtml(data);
    this.footer.hidden = this.footer.innerHTML === "";
  }

  // ---------- chart ----------

  private linesFor(data: StatsData): Line[] {
    if (this.tab === "you") {
      const s = data.me == null ? undefined : data.stats.get(data.me);
      if (!s) return [];
      return FLOWS.map((f) => ({ label: f.label, color: f.color, t: s.history.time, v: rates(s, f.key) }));
    }
    const lines: Line[] = [];
    for (const p of data.players) {
      const s = data.stats.get(p.id);
      if (!s || s.history.time.length === 0) continue;
      const h = s.history;
      const v =
        this.tab === "held" ? h.held
        : this.tab === "colonies" ? h.colonies
        : this.tab === "income" ? sum(rates(s, "gathered"), rates(s, "drained"))
        : rates(s, this.tab);
      lines.push({ label: p.name, color: p.color, t: h.time, v });
    }
    return lines;
  }

  private chartBox() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return { left: 44, right: w - 10, top: 8, bottom: h - 22, w, h };
  }

  private span(): [number, number] {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const l of this.lines) {
      if (!l.t.length) continue;
      t0 = Math.min(t0, l.t[0]);
      t1 = Math.max(t1, l.t[l.t.length - 1]);
    }
    if (!isFinite(t0)) return [0, 60];
    return [t0, Math.max(t1, t0 + 10)];
  }

  private timeAt(x: number): number | null {
    const box = this.chartBox();
    if (x < box.left || x > box.right) return null;
    const [t0, t1] = this.span();
    return t0 + ((x - box.left) / (box.right - box.left)) * (t1 - t0);
  }

  private drawChart(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const box = this.chartBox();
    if (box.w === 0) return;
    if (canvas.width !== Math.round(box.w * dpr) || canvas.height !== Math.round(box.h * dpr)) {
      canvas.width = Math.round(box.w * dpr);
      canvas.height = Math.round(box.h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);

    const [t0, t1] = this.span();
    let vmax = 0;
    for (const l of this.lines) for (const v of l.v) vmax = Math.max(vmax, v);
    const yTicks = niceTicks(vmax || 1);
    const ymax = yTicks[yTicks.length - 1];
    const X = (t: number) => box.left + ((t - t0) / (t1 - t0)) * (box.right - box.left);
    const Y = (v: number) => box.bottom - (v / ymax) * (box.bottom - box.top);

    // Grid and axes.
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#888";
    ctx.strokeStyle = "#eceef0";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of yTicks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(formatNumber(v), box.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const step = niceStep((t1 - t0) / 6, [10, 15, 30, 60, 120, 300, 600, 900, 1800]);
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ctx.fillText(formatTime(t), X(t), box.bottom + 6);

    // Lines.
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    for (const l of this.lines) {
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      for (let i = 0; i < l.t.length; i++) {
        const joined = i > 0 && l.t[i] - l.t[i - 1] <= GAP_SECONDS;
        if (joined) ctx.lineTo(X(l.t[i]), Y(l.v[i]));
        else ctx.moveTo(X(l.t[i]), Y(l.v[i]));
      }
      ctx.stroke();
    }

    // Hover: a guide line and each line's value there.
    const at = this.hoverT;
    if (at != null) {
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(X(at)) + 0.5, box.top);
      ctx.lineTo(Math.round(X(at)) + 0.5, box.bottom);
      ctx.stroke();
      for (const l of this.lines) {
        const i = nearest(l.t, at);
        if (i < 0) continue;
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.arc(X(l.t[i]), Y(l.v[i]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const label = at == null ? "" : `<span class="at">at ${formatTime(at)}</span>`;
    this.legend.innerHTML =
      label +
      this.lines
        .map((l) => {
          const i = at == null ? l.v.length - 1 : nearest(l.t, at);
          const v = i < 0 ? "–" : formatNumber(l.v[i], this.tab !== "colonies");
          return `<span><i style="background:${l.color}"></i>${escape(l.label)} <b>${v}</b></span>`;
        })
        .join("") +
      (this.lines.length === 0 ? `<span class="empty">No data yet</span>` : "");
  }
}

// ---------- table ----------

function ranked(data: StatsData): StatsPlayer[] {
  const players = data.players.filter((p) => data.stats.has(p.id));
  const died = (p: StatsPlayer) => (p.alive ? Infinity : data.stats.get(p.id)!.diedAt ?? -Infinity);
  return players.sort((a, b) =>
    data.rankBy === "survival" ? died(b) - died(a) || b.score - a.score : b.score - a.score,
  );
}

function tableHtml(data: StatsData): string {
  const rows = ranked(data).map((p, i) => {
    const s = data.stats.get(p.id)!;
    const out = !p.alive && s.diedAt != null ? `out at ${formatTime(s.diedAt / SIM_HZ)}` : p.alive ? "alive" : "left";
    const cells = [
      `${i + 1}.`,
      `<i style="background:${p.color}"></i>${escape(p.name)}`,
      out,
      s.peakColonies,
      formatNumber(s.peakHeld),
      formatNumber(s.gathered),
      formatNumber(s.drained),
      formatNumber(s.lost),
      formatNumber(s.upkeep + s.walls),
      s.kills,
    ];
    return `<tr class="${p.id === data.me ? "you" : ""}">${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  });
  const head = ["", "Player", "Status", "Peak colonies", "Peak held", "Gathered", "Drained", "Lost", "Spent", "Kills"];
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function footerHtml(data: StatsData): string {
  const s = data.me == null ? undefined : data.stats.get(data.me);
  if (!s) return "";
  const n = (count: number, one: string, many = `${one}s`) => `<b>${count}</b> ${count === 1 ? one : many}`;
  return (
    `You threw ${n(s.throws, "colony", "colonies")}, grew ${n(s.hyphae, "hypha", "hyphae")}, ` +
    `built ${n(s.wallsBuilt, "wall")}, captured ${n(s.boosts, "boost")} and lost ${n(s.coloniesLost, "colony", "colonies")}.`
  );
}

// ---------- helpers ----------

/** A running total turned into a per-second rate, averaged over RATE_WINDOW seconds. */
function rates(s: PlayerStats, key: Series): number[] {
  const t = s.history.time;
  const c = s.history[key];
  return c.map((v, i) => {
    let j = i;
    while (j > 0 && t[i] - t[j - 1] <= RATE_WINDOW) j--;
    const dt = t[i] - t[j];
    return dt > 0 ? Math.max(0, (v - c[j]) / dt) : 0;
  });
}

const sum = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));

/** Index of the sample nearest time `t`, or -1 when there are none. */
function nearest(times: number[], t: number): number {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - times[lo - 1] < times[lo] - t ? lo - 1 : lo;
}

function niceStep(raw: number, steps: number[]): number {
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1];
}

/** 0 and 3–5 round values reaching at least `max`. */
function niceTicks(max: number): number[] {
  const mag = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 4 >= max)!;
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

function formatNumber(v: number, decimals = true): string {
  if (v >= 10000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k`;
  if (v >= 100 || !decimals) return Math.round(v).toLocaleString();
  return (Math.round(v * 10) / 10).toString();
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const escape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
