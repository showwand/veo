// Downloads a snapshot of UK speed cameras from OpenStreetMap (via Overpass)
// and saves it to public/cameras-uk.json, so the app never has to ask Overpass
// for cameras while you are using it.
//
// Run:  node scripts/update-cameras.mjs
// Add --force to overwrite the file even if the new snapshot looks much smaller.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// !! Replace with your real email. Overpass operators use it to contact you if needed.
const CONTACT_EMAIL = "you@example.com";

// Tried in order, then the whole list is retried (with a wait) a few times.
// I haven't verified that every server here is alive; failures just move on to the next.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const ROUNDS = 4;
const WAIT_BETWEEN_ROUNDS_MS = 20000; // multiplied by the round number
const REQUEST_TIMEOUT_MS = 240000; // the UK query is small but the server may queue it

// Refuse to save a suspiciously small snapshot (a failed or partial download)
const MIN_EXPECTED_CAMERAS = 300;

const OUTPUT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "cameras-uk.json"
);

// Only real speed enforcement:
//  - highway=speed_camera
//  - enforcement=maxspeed or enforcement=average_speed (also inside lists like "maxspeed;traffic_signals")
// Plain traffic lights and other generic enforcement are never requested.
const QUERY = `
[out:json][timeout:180];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  node["highway"="speed_camera"](area.uk);
  node["enforcement"~"(^|;)(maxspeed|average_speed)(;|$)"](area.uk);
);
out;
`;

// The OSM tags we keep. The app's existing classification code reads these.
const KEEP_TAGS = [
  "highway",
  "enforcement",
  "maxspeed",
  "direction",
  "camera:direction",
  "camera:type",
  "camera:mount",
  "name",
  "ref",
  "operator",
  "check_date",
  "survey:date",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tryEndpoint(endpoint) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `Veode-camera-snapshot/1.0 (${CONTACT_EMAIL})`,
    },
    body: `data=${encodeURIComponent(QUERY)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const hint = response.status === 429 ? " (no free slot, server busy)" : "";
    throw new Error(`HTTP ${response.status}${hint}`);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("reply was not JSON (probably an error page)");
  }

  // Overpass can answer "200 OK" with a remark saying it ran out of time or memory.
  // That result may be incomplete, so it counts as a failure.
  if (data.remark && /error|timed out|out of memory/i.test(String(data.remark))) {
    throw new Error(`server remark: ${data.remark}`);
  }
  if (!Array.isArray(data.elements)) throw new Error("reply had no elements list");

  return data.elements;
}

async function download() {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const endpoint of ENDPOINTS) {
      const started = Date.now();
      console.log(`[round ${round}/${ROUNDS}] asking ${endpoint} ...`);
      try {
        const elements = await tryEndpoint(endpoint);
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(`  OK: ${elements.length} objects in ${seconds} s`);
        return { elements, endpoint };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  failed: ${message}`);
      }
    }
    if (round < ROUNDS) {
      const wait = WAIT_BETWEEN_ROUNDS_MS * round;
      console.log(`All servers failed. Waiting ${wait / 1000} s before trying again...`);
      await sleep(wait);
    }
  }
  throw new Error("Every Overpass server failed in every round. Try again later.");
}

// Turns raw OSM nodes into our camera records, dropping anything that isn't speed enforcement
function normalise(elements) {
  const cameras = new Map();
  const dropped = { notSpeedEnforcement: 0, noPosition: 0 };

  for (const element of elements) {
    if (element.type !== "node" || typeof element.lat !== "number" || typeof element.lon !== "number") {
      dropped.noPosition++;
      continue;
    }
    const tags = element.tags ?? {};
    const enforcement = typeof tags.enforcement === "string" ? tags.enforcement.trim() : "";
    const values = enforcement ? enforcement.split(";").map((v) => v.trim()) : [];

    const hasSpeedEnforcement = values.includes("maxspeed") || values.includes("average_speed");
    const isSpeedCameraNode = tags.highway === "speed_camera";

    // A highway=speed_camera node that ALSO says enforcement=traffic_signals (and nothing
    // about speed) is not claimed to be a speed camera, so it is dropped.
    if (!(hasSpeedEnforcement || (isSpeedCameraNode && enforcement === ""))) {
      dropped.notSpeedEnforcement++;
      continue;
    }

    const kept = {};
    for (const key of KEEP_TAGS) {
      if (typeof tags[key] === "string" && tags[key].trim() !== "") kept[key] = tags[key];
    }

    cameras.set(element.id, {
      id: element.id,
      lat: Number(element.lat.toFixed(6)),
      lon: Number(element.lon.toFixed(6)),
      // Convenience fields for humans reading the file. The app reads "tags".
      type: values.includes("average_speed") ? "average_speed" : "speed",
      maxspeed: kept.maxspeed ?? null,
      direction: kept.direction ?? kept["camera:direction"] ?? null,
      tags: kept,
    });
  }

  const list = [...cameras.values()].sort((a, b) => a.id - b.id);
  return { list, dropped };
}

async function readExistingCount() {
  try {
    const existing = JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
    return typeof existing.count === "number" ? existing.count : null;
  } catch {
    return null;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  console.log("Veode: downloading UK speed cameras from OpenStreetMap");

  const { elements, endpoint } = await download();
  const { list, dropped } = normalise(elements);

  const bySpeed = list.filter((c) => c.type === "speed").length;
  const byAverage = list.filter((c) => c.type === "average_speed").length;
  console.log(`Kept ${list.length} cameras (${bySpeed} speed, ${byAverage} average-speed)`);
  console.log(
    `  with a speed limit: ${list.filter((c) => c.maxspeed).length}, ` +
      `with a direction: ${list.filter((c) => c.direction).length}`
  );
  console.log(
    `Dropped: ${dropped.notSpeedEnforcement} not speed enforcement, ${dropped.noPosition} without a position`
  );

  if (list.length < MIN_EXPECTED_CAMERAS && !force) {
    throw new Error(
      `Only ${list.length} cameras: that looks wrong, so the file was NOT changed. ` +
        `(Use --force to save it anyway.)`
    );
  }
  const previous = await readExistingCount();
  if (previous !== null && list.length < previous * 0.5 && !force) {
    throw new Error(
      `The new snapshot (${list.length}) is less than half the old one (${previous}), ` +
        `so the file was NOT changed. (Use --force to save it anyway.)`
    );
  }

  const header = {
    format: 1,
    generatedAt: new Date().toISOString(),
    source: "OpenStreetMap contributors, ODbL 1.0, via the Overpass API",
    area: "United Kingdom (ISO3166-1 = GB)",
    endpoint,
    count: list.length,
  };

  // One camera per line, so the file is easy to look at and to compare between updates
  const headerText = JSON.stringify(header).slice(0, -1);
  const body = list.map((camera) => JSON.stringify(camera)).join(",\n");
  const text = `${headerText},"cameras":[\n${body}\n]}\n`;

  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  const temporary = `${OUTPUT_FILE}.tmp`;
  await writeFile(temporary, text, "utf8"); // written aside first, so a crash never leaves a half file
  await rename(temporary, OUTPUT_FILE);

  console.log(`Saved ${OUTPUT_FILE} (${Math.round(text.length / 1024)} KB)`);
}

main().catch((error) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});