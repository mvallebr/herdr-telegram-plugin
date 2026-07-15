#!/usr/bin/env node
/**
 * Opt-in operational preflight. It deliberately does not send messages or
 * consume updates: a human performs the final round trip in Telegram.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const config = join(process.env.HOME ?? homedir(), ".config", "herdr-telegram", "config.toml");
const contents = existsSync(config) ? readFileSync(config, "utf8") : "";
const configured = contents.match(/^\s*bot_token\s*=\s*["']?([^\s"']+)/m)?.[1];
const token = process.env.HERDR_TG_BOT_TOKEN ?? configured;

if (!token) {
  console.error(`Smoke failed: set HERDR_TG_BOT_TOKEN or configure ${config}`);
  process.exit(1);
}

const herdr = spawnSync(process.env.HERDR_BIN_PATH ?? "herdr", ["agent", "list"], { encoding: "utf8", timeout: 30_000 });
if (herdr.error || herdr.status !== 0) {
  console.error(`Smoke failed: herdr agent list: ${herdr.error?.message ?? herdr.stderr.trim()}`);
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const body = await response.json();
if (!response.ok || !body.ok) {
  console.error(`Smoke failed: Telegram getMe: ${body.description ?? response.statusText}`);
  process.exit(1);
}

console.log(`Smoke preflight passed for @${body.result.username}.`);
console.log("Start the daemon, send a message in a bound topic, and confirm one clean reply arrives.");
