/**
 * User-defined text-property presets ("My Presets").
 *
 * Stored locally in `localStorage` per browser — keeps the feature simple
 * and instant (no Supabase round-trip). Each preset captures a snapshot
 * of `CaptionStyleOverrides` (everything the Text panel can edit) under
 * a user-chosen name.
 *
 * Schema:
 *   { id: uuid, name: "Bold White", overrides: {...}, createdAt: number }
 *
 * Storage key:
 *   captora.textPresets.v1
 */

"use client";

import type { CaptionStyleOverrides } from "./styles";

const STORAGE_KEY = "captora.textPresets.v1";

export interface TextPreset {
  id: string;
  name: string;
  overrides: CaptionStyleOverrides;
  createdAt: number;
}

function read(): TextPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TextPreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(presets: TextPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn("[textPresets] save failed:", err);
  }
}

export function listTextPresets(): TextPreset[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

export function saveTextPreset(name: string, overrides: CaptionStyleOverrides): TextPreset {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Preset name is required");
  const all = read();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const preset: TextPreset = { id, name: trimmed, overrides, createdAt: Date.now() };
  // If a preset with the same name exists, replace it (most users expect overwrite).
  const next = all.filter((p) => p.name.toLowerCase() !== trimmed.toLowerCase());
  next.push(preset);
  write(next);
  return preset;
}

export function deleteTextPreset(id: string): void {
  const all = read();
  write(all.filter((p) => p.id !== id));
}
