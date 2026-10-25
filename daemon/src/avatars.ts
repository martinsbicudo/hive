import { createAvatar } from "@dicebear/core";
import { adventurer, bottts, lorelei, micah, notionists, personas, thumbs } from "@dicebear/collection";
import { Resvg } from "@resvg/resvg-js";

const STYLES = { notionists, lorelei, adventurer, personas, micah, bottts, thumbs };
type StyleName = keyof typeof STYLES;

export const AVATAR_STYLES: readonly string[] = Object.keys(STYLES);
export const DEFAULT_AVATAR_STYLE: StyleName = "notionists";

const BACKGROUNDS = ["f2a33a", "7cc4b8", "a7b6f2", "f2b6c4", "c9e27a", "f4d58d", "b8a7f2", "9fd3f2"];

function styleNamed(name: string): StyleName {
  return Object.keys(STYLES).find((key): key is StyleName => key === name) ?? DEFAULT_AVATAR_STYLE;
}

const OPTIONS = { size: 256, radius: 50, backgroundColor: BACKGROUNDS, backgroundType: ["solid" as const] };

export function avatarSvg(style: string, seed: string): string {
  const options = { ...OPTIONS, seed };
  switch (styleNamed(style)) {
    case "notionists": return createAvatar(notionists, options).toString();
    case "lorelei": return createAvatar(lorelei, options).toString();
    case "adventurer": return createAvatar(adventurer, options).toString();
    case "personas": return createAvatar(personas, options).toString();
    case "micah": return createAvatar(micah, options).toString();
    case "bottts": return createAvatar(bottts, options).toString();
    case "thumbs": return createAvatar(thumbs, options).toString();
  }
}

export function avatarPng(style: string, seed: string, size: number): Buffer {
  return new Resvg(avatarSvg(style, seed), { fitTo: { mode: "width", value: size } }).render().asPng();
}
