import { FURNITURE_BY_ID, ROOMS, STAT_KEYS, STAT_LABEL } from "./data";
import type { OptimizeResult, RoomGoal } from "./optimizer";
import { PRESET_BY_ID } from "./presets";

/**
 * Renders the current house as one PNG: every active room grid (taken from the live SVGs on the page,
 * with theme colours baked in) plus title, goal and stat lines drawn on a canvas. No server, no libraries.
 */
export async function exportHouseImage(opts: {
  result: OptimizeResult;
  goals: RoomGoal[];
  ownedCount: number;
  fileName?: string;
}): Promise<void> {
  const { result, goals } = opts;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const hsl = (name: string) => `hsl(${v(name)})`;

  // resolve `hsl(var(--x))` and `var(--font-mono)` so the SVG renders outside the page's stylesheet
  const inline = (svgText: string) =>
    svgText
      .replace(/hsl\(var\((--[a-z0-9-]+)\)\)/g, (_m, name) => hsl(name))
      .replace(/var\(--font-mono\)/g, "ui-monospace, Menlo, monospace")
      .replace(/var\(--font-sans\)/g, "system-ui, sans-serif");

  const svgToImage = (svgEl: SVGSVGElement): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const vb = svgEl.viewBox.baseVal;
      clone.setAttribute("width", String(vb.width));
      clone.setAttribute("height", String(vb.height));
      const text = inline(new XMLSerializer().serializeToString(clone));
      const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("could not render room"));
      };
      img.src = url;
    });

  const rooms = result.rooms.map((r, i) => ({
    r,
    g: goals[i] ?? goals.find((g) => g.roomId === r.roomId),
    svg: document.querySelector<SVGSVGElement>(`svg[aria-label="Layout for ${ROOMS[r.roomId].label}"]`),
  }));
  const images = await Promise.all(rooms.map((x) => (x.svg ? svgToImage(x.svg) : Promise.resolve(null))));

  // one tile size for every room, so a 16-wide room is not blown up to the attic's width
  const scale = 2;
  const W = 1200;
  const pad = 40;
  const gap = 28;
  const innerW = W - pad * 2;
  const headerH = 96;
  const roomHeaderH = 78;
  const footerH = 56;
  const maxCols = Math.max(1, ...images.map((im) => im?.width ?? 1));
  const tile = innerW / maxCols;
  type Block = { i: number; w: number; h: number; x: number; y: number };
  const blocks: Block[] = [];
  let cx = pad;
  let cy = headerH;
  let rowH = 0;
  rooms.forEach((_x, i) => {
    const img = images[i];
    const w = img ? img.width * tile : innerW / 2;
    const h = roomHeaderH + (img ? img.height * tile : 0);
    if (cx > pad && cx + w > W - pad + 0.5) {
      cx = pad;
      cy += rowH + gap;
      rowH = 0;
    }
    blocks.push({ i, w, h, x: cx, y: cy });
    cx += w + gap;
    rowH = Math.max(rowH, h);
  });
  const H = cy + rowH + gap + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = hsl("--background");
  ctx.fillRect(0, 0, W, H);

  const fg = hsl("--foreground");
  const muted = hsl("--muted-foreground");
  const sans = "system-ui, -apple-system, Segoe UI, sans-serif";
  const mono = "ui-monospace, Menlo, monospace";

  ctx.fillStyle = fg;
  ctx.font = `700 26px ${sans}`;
  ctx.fillText("Mewgenics House Planner", pad, 44);
  ctx.fillStyle = muted;
  ctx.font = `400 14px ${sans}`;
  const placed = result.rooms.reduce((a, r) => a + r.placements.length, 0);
  ctx.fillText(
    `${placed} of ${opts.ownedCount} pieces placed · House Appeal ${result.houseAppeal} · score ${result.totalScore.toFixed(1)} · ${new Date().toLocaleDateString()}`,
    pad,
    70,
  );

  for (const b of blocks) {
    const x = rooms[b.i];
    const img = images[b.i];
    const def = ROOMS[x.r.roomId];
    const g = x.g;
    const clipW = b.w;
    const fit = (t: string, font: string) => {
      ctx.font = font;
      let out = t;
      while (out.length > 4 && ctx.measureText(out).width > clipW) out = out.slice(0, -2).trimEnd() + "…";
      return out;
    };
    ctx.fillStyle = fg;
    ctx.fillText(fit(def.label, `700 18px ${sans}`), b.x, b.y + 22);
    ctx.fillStyle = muted;
    const preset = g ? PRESET_BY_ID[g.preset]?.label ?? g.preset : "";
    ctx.fillText(fit(`${preset}${g ? ` · ${g.cats} cats` : ""} · ${x.r.placements.length} pieces · ${x.r.usedCells}/${def.free} tiles`, `400 13px ${sans}`), b.x, b.y + 42);
    let sx = b.x;
    ctx.font = `600 13px ${mono}`;
    for (const k of STAT_KEYS) {
      const label = `${STAT_LABEL[k]} ${x.r.stats[k]}`;
      const wdt = ctx.measureText(label).width;
      if (sx + wdt > b.x + clipW) break;
      ctx.fillStyle = hsl(`--stat-${k}`);
      ctx.fillText(label, sx, b.y + 64);
      sx += wdt + 18;
    }
    if (img) ctx.drawImage(img, b.x, b.y + roomHeaderH, img.width * tile, img.height * tile);
  }

  // legend of the numbered pieces is too long for an image; point at the app instead
  ctx.fillStyle = muted;
  ctx.font = `400 12px ${sans}`;
  ctx.fillText("Numbers are placement order (every stacked piece comes after its base). Hover a piece in the app for its name and stats.", pad, H - 18);

  const leftovers = result.leftovers.filter((l) => l.reason === "no-space");
  if (leftovers.length) {
    // small note so people know the image is not the whole inventory
    const names = leftovers.slice(0, 6).map((l) => FURNITURE_BY_ID[l.itemId].name);
    ctx.fillText(`Not placed for lack of space: ${names.join(", ")}${leftovers.length > 6 ? ` and ${leftovers.length - 6} more` : ""}`, pad, H - 34);
  }

  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("could not encode image");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = opts.fileName ?? `mewgenics-house-${new Date().toISOString().slice(0, 10)}.png`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
