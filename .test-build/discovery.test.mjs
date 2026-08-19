// tests/discovery.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join as join3 } from "node:path";

// src/vfs/protocol.ts
var LOCAL_SEGMENT = "_local";
function namespacePrefix(basePath2, segment) {
  return `${basePath2}${segment}/`;
}

// src/vfs/client.ts
var basePath = null;
function getBasePath() {
  return basePath ?? new URL("./", location.href).pathname;
}
function encodePath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function localUrl(mountId, relativePath = "") {
  const prefix = namespacePrefix(getBasePath(), LOCAL_SEGMENT);
  return new URL(
    `${prefix}${encodeURIComponent(mountId)}/${encodePath(relativePath)}`,
    location.origin
  ).href;
}

// src/preview/policy.ts
var MAX_PREVIEW_ELEMENTS = 1 << 20;
var MAX_PREVIEW_EXTENT = 4096;
function isPreviewable(shape, yx) {
  if (shape.length < 2) return false;
  const height = shape[yx[0]];
  const width = shape[yx[1]];
  if (!(height > 0) || !(width > 0)) return false;
  if (height > MAX_PREVIEW_EXTENT || width > MAX_PREVIEW_EXTENT) return false;
  const elements = shape.reduce((total, extent) => total * extent, 1);
  return elements > 0 && elements <= MAX_PREVIEW_ELEMENTS;
}
function spatialAxes(axes, rank) {
  if (axes && axes.length === rank) {
    const y = axes.findIndex((axis) => axis.toLowerCase() === "y");
    const x = axes.findIndex((axis) => axis.toLowerCase() === "x");
    if (y !== -1 && x !== -1) return [y, x];
  }
  return [rank - 2, rank - 1];
}

// src/discovery/zarr-metadata.ts
var MetadataError = class extends Error {
};
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readJsonFile(directory, name) {
  let file;
  try {
    const handle = await directory.getFileHandle(name);
    file = await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError")) {
      return void 0;
    }
    throw error;
  }
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MetadataError(`${name} is not valid JSON: ${error.message}`);
  }
  if (!isObject(parsed)) {
    throw new MetadataError(`${name} does not contain a JSON object`);
  }
  return parsed;
}
async function readZarrNode(directory) {
  const v3 = await readJsonFile(directory, "zarr.json");
  if (v3) {
    const nodeType = typeof v3.node_type === "string" ? v3.node_type : "group";
    if (nodeType === "array") return { kind: "array", format: 3 };
    const attributes = isObject(v3.attributes) ? v3.attributes : {};
    return { kind: "group", format: 3, attributes };
  }
  if (await readJsonFile(directory, ".zarray")) {
    return { kind: "array", format: 2 };
  }
  const zgroup = await readJsonFile(directory, ".zgroup");
  const zattrs = await readJsonFile(directory, ".zattrs");
  if (zgroup || zattrs) {
    return { kind: "group", format: 2, attributes: zattrs ?? {} };
  }
  return { kind: "none" };
}
function omeAttributes(node) {
  const bags = [];
  if (isObject(node.attributes.ome)) bags.push(node.attributes.ome);
  bags.push(node.attributes);
  return bags;
}
function readMultiscale(node) {
  for (const bag of omeAttributes(node)) {
    const multiscales = bag.multiscales;
    if (!Array.isArray(multiscales) || multiscales.length === 0) continue;
    const first = multiscales[0];
    if (!isObject(first)) continue;
    const paths = [];
    if (Array.isArray(first.datasets)) {
      for (const entry of first.datasets) {
        if (isObject(entry) && typeof entry.path === "string") paths.push(entry.path);
      }
    }
    let axes;
    if (Array.isArray(first.axes)) {
      const names = first.axes.map(
        (axis) => (
          // NGFF >= 0.4 uses objects; 0.3 used bare strings.
          typeof axis === "string" ? axis : isObject(axis) && typeof axis.name === "string" ? axis.name : "?"
        )
      );
      if (names.length > 0) axes = names;
    }
    const version = typeof bag.version === "string" ? bag.version : typeof first.version === "string" ? first.version : void 0;
    return {
      version,
      axes,
      paths,
      name: typeof first.name === "string" ? first.name : void 0
    };
  }
  return null;
}
function hasThumbnailsConvention(node) {
  if (node.format !== 3) return false;
  const thumbnails = node.attributes.thumbnails;
  return Array.isArray(thumbnails) && thumbnails.length > 0;
}
function isPlate(node) {
  return omeAttributes(node).some((bag) => isObject(bag.plate));
}
function isBioformats2RawLayout(node) {
  return omeAttributes(node).some((bag) => bag["bioformats2raw.layout"] !== void 0);
}
function readArrayInfo(raw) {
  const shape = Array.isArray(raw.shape) && raw.shape.every((n) => typeof n === "number") ? raw.shape : void 0;
  const dtype = typeof raw.data_type === "string" ? raw.data_type : typeof raw.dtype === "string" ? raw.dtype : void 0;
  return { shape, dtype };
}

// src/discovery/types.ts
var DEFAULT_LIMITS = {
  maxDepth: 10,
  maxDatasets: 1e3,
  maxDirectories: 2e4,
  maxEntriesPerDirectory: 5e3
};

// src/discovery/discover.ts
var IGNORED_NAMES = /* @__PURE__ */ new Set(["__MACOSX", ".DS_Store", "Thumbs.db", ".git"]);
function isIgnored(name) {
  return IGNORED_NAMES.has(name) || name.startsWith(".");
}
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}
function displayName(relativePath, mount, multiscale) {
  const base = relativePath === "" ? mount.name : relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const stripped = base.replace(/\.ome\.zarr$/i, "").replace(/\.zarr$/i, "");
  return stripped || multiscale.name || base || "Untitled";
}
function displayPath(relativePath, mount) {
  return relativePath === "" ? mount.name : `${mount.name}/${relativePath}`;
}
function note(context, note2) {
  context.notes.push(note2);
}
function reportLimit(context, key, message) {
  if (context.limitReported.has(key)) return;
  context.limitReported.add(key);
  note(context, { kind: "limit", path: context.mount.name, message });
}
async function readLevelInfo(directory, levelPath, format) {
  try {
    let current = directory;
    for (const segment of levelPath.split("/").filter(Boolean)) {
      current = await current.getDirectoryHandle(segment);
    }
    const raw = format === 3 ? await readJsonFile(current, "zarr.json") : await readJsonFile(current, ".zarray");
    return raw ? readArrayInfo(raw) : {};
  } catch {
    return {};
  }
}
async function checkPreviewable(directory, multiscale, format) {
  const coarsest = multiscale.paths[multiscale.paths.length - 1];
  if (!coarsest) return false;
  const { shape } = await readLevelInfo(directory, coarsest, format);
  if (!shape || shape.length < 2) return false;
  return isPreviewable(shape, spatialAxes(multiscale.axes, shape.length));
}
async function recordDataset(context, directory, relativePath, node, multiscale) {
  const { mount } = context;
  const finest = multiscale.paths[0];
  const { shape, dtype } = finest ? await readLevelInfo(directory, finest, node.format) : {};
  const hasConventionThumbnail = hasThumbnailsConvention(node);
  const previewable = hasConventionThumbnail ? false : await checkPreviewable(directory, multiscale, node.format);
  context.datasets.push({
    id: `${mount.id}:${relativePath || "."}`,
    name: displayName(relativePath, mount, multiscale),
    relativePath,
    virtualUrl: ensureTrailingSlash(context.buildUrl(mount.id, relativePath)),
    omeZarrVersion: multiscale.version,
    mountId: mount.id,
    mountName: mount.name,
    zarrFormat: node.format,
    axes: multiscale.axes,
    shape,
    dtype,
    scaleCount: multiscale.paths.length || void 0,
    hasConventionThumbnail,
    previewable
  });
}
async function childDirectories(context, directory, relativePath) {
  const children = [];
  let seen = 0;
  for await (const entry of directory.values()) {
    if (++seen > context.limits.maxEntriesPerDirectory) {
      note(context, {
        kind: "limit",
        path: displayPath(relativePath, context.mount),
        message: `Stopped after ${context.limits.maxEntriesPerDirectory} entries in this folder.`
      });
      break;
    }
    if (entry.kind !== "directory" || isIgnored(entry.name)) continue;
    children.push(entry);
  }
  children.sort((a, b) => a.name.localeCompare(b.name, void 0, { numeric: true }));
  return children;
}
async function walk(context, directory, relativePath, depth) {
  context.options.signal?.throwIfAborted();
  if (context.datasets.length >= context.limits.maxDatasets) {
    reportLimit(
      context,
      "datasets",
      `Stopped after ${context.limits.maxDatasets} datasets; the folder contains more.`
    );
    return;
  }
  if (context.directoriesScanned >= context.limits.maxDirectories) {
    reportLimit(
      context,
      "directories",
      `Stopped after scanning ${context.limits.maxDirectories} folders.`
    );
    return;
  }
  context.directoriesScanned += 1;
  context.options.onProgress?.({
    directoriesScanned: context.directoriesScanned,
    datasetsFound: context.datasets.length,
    currentPath: displayPath(relativePath, context.mount)
  });
  let node;
  try {
    node = await readZarrNode(directory);
  } catch (error) {
    note(context, {
      kind: "error",
      path: displayPath(relativePath, context.mount),
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  if (node.kind === "array") {
    if (depth === 0) {
      note(context, {
        kind: "unsupported",
        path: displayPath(relativePath, context.mount),
        message: "This is a bare Zarr array, not an OME-Zarr multiscale image. Drop the group that contains it."
      });
    }
    return;
  }
  if (node.kind === "group") {
    const multiscale = readMultiscale(node);
    if (multiscale) {
      await recordDataset(context, directory, relativePath, node, multiscale);
      return;
    }
    if (isPlate(node)) {
      note(context, {
        kind: "skipped",
        path: displayPath(relativePath, context.mount),
        message: "HCS plate: listing the images inside it individually."
      });
    } else if (isBioformats2RawLayout(node)) {
      note(context, {
        kind: "skipped",
        path: displayPath(relativePath, context.mount),
        message: "bioformats2raw container: listing its image series individually."
      });
    }
  }
  if (depth >= context.limits.maxDepth) {
    reportLimit(
      context,
      "depth",
      `Stopped at ${context.limits.maxDepth} folders deep; deeper datasets were not searched.`
    );
    return;
  }
  let children;
  try {
    children = await childDirectories(context, directory, relativePath);
  } catch (error) {
    note(context, {
      kind: "error",
      path: displayPath(relativePath, context.mount),
      message: `Could not list this folder: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }
  for (const child of children) {
    const childPath = relativePath === "" ? child.name : `${relativePath}/${child.name}`;
    await walk(context, child, childPath, depth + 1);
  }
}
async function discoverInMount(mount, options = {}) {
  const context = {
    mount,
    buildUrl: options.urlBuilder ?? localUrl,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    datasets: [],
    notes: [],
    directoriesScanned: 0,
    limitReported: /* @__PURE__ */ new Set(),
    options
  };
  try {
    await walk(context, mount.handle, "", 0);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    context.notes.push({
      kind: "error",
      path: mount.name,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return {
    datasets: context.datasets,
    notes: context.notes,
    directoriesScanned: context.directoriesScanned
  };
}

// tests/fixtures.ts
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function writeJson(path, value) {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}
async function makeV2Image(root, levels = 2) {
  await writeJson(join(root, ".zgroup"), { zarr_format: 2 });
  await writeJson(join(root, ".zattrs"), {
    multiscales: [
      {
        version: "0.4",
        name: "example",
        axes: [
          { name: "c", type: "channel" },
          { name: "y", type: "space", unit: "micrometer" },
          { name: "x", type: "space", unit: "micrometer" }
        ],
        datasets: Array.from({ length: levels }, (_, index) => ({
          path: String(index),
          coordinateTransformations: [{ type: "scale", scale: [1, 2 ** index, 2 ** index] }]
        }))
      }
    ]
  });
  for (let level = 0; level < levels; level += 1) {
    const size = 64 >> level;
    await writeJson(join(root, String(level), ".zarray"), {
      zarr_format: 2,
      shape: [2, size, size],
      chunks: [1, size, size],
      dtype: "<u2",
      compressor: null,
      fill_value: 0,
      order: "C",
      filters: null
    });
    for (let channel = 0; channel < 2; channel += 1) {
      const chunkPath = join(root, String(level), String(channel), "0", "0");
      await fs.mkdir(join(chunkPath, ".."), { recursive: true });
      await fs.writeFile(chunkPath, Buffer.alloc(size * size * 2, level + 1));
    }
  }
}
async function makeV3Image(root) {
  await writeJson(join(root, "zarr.json"), {
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [
          {
            name: "v3 example",
            axes: [
              { name: "z", type: "space" },
              { name: "y", type: "space" },
              { name: "x", type: "space" }
            ],
            datasets: [
              { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }] }
            ]
          }
        ]
      }
    }
  });
  await writeJson(join(root, "0", "zarr.json"), {
    zarr_format: 3,
    node_type: "array",
    shape: [8, 32, 32],
    data_type: "uint8",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [8, 32, 32] } },
    chunk_key_encoding: { name: "default" },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0
  });
  const chunk = join(root, "0", "c", "0", "0", "0");
  await fs.mkdir(join(chunk, ".."), { recursive: true });
  await fs.writeFile(chunk, Buffer.alloc(8 * 32 * 32, 7));
}
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "ome-zarr-portal-"));
  await makeV2Image(join(root, "v2-image.ome.zarr"));
  await makeV3Image(join(root, "nested", "deeper", "v3-image.ome.zarr"));
  await writeJson(join(root, "bare-array.zarr", ".zarray"), {
    zarr_format: 2,
    shape: [4, 4],
    chunks: [4, 4],
    dtype: "<f4",
    compressor: null,
    fill_value: 0,
    order: "C",
    filters: null
  });
  const plate = join(root, "plate.ome.zarr");
  await writeJson(join(plate, ".zgroup"), { zarr_format: 2 });
  await writeJson(join(plate, ".zattrs"), {
    plate: {
      version: "0.4",
      columns: [{ name: "1" }],
      rows: [{ name: "A" }],
      wells: [{ path: "A/1", rowIndex: 0, columnIndex: 0 }]
    }
  });
  await writeJson(join(plate, "A", "1", ".zgroup"), { zarr_format: 2 });
  await writeJson(join(plate, "A", "1", ".zattrs"), {
    well: { version: "0.4", images: [{ path: "0" }] }
  });
  await makeV2Image(join(plate, "A", "1", "0"), 1);
  const big = join(root, "big-pyramid.ome.zarr");
  await writeJson(join(big, ".zgroup"), { zarr_format: 2 });
  await writeJson(join(big, ".zattrs"), {
    multiscales: [
      {
        version: "0.4",
        axes: [
          { name: "y", type: "space" },
          { name: "x", type: "space" }
        ],
        datasets: [{ path: "0" }]
      }
    ]
  });
  await writeJson(join(big, "0", ".zarray"), {
    zarr_format: 2,
    shape: [8192, 8192],
    chunks: [512, 512],
    dtype: "<u2",
    compressor: null,
    fill_value: 0,
    order: "C",
    filters: null
  });
  const thumbed = join(root, "thumbed.ome.zarr");
  await writeJson(join(thumbed, "zarr.json"), {
    zarr_format: 3,
    node_type: "group",
    attributes: {
      thumbnails: [{ width: 256, height: 256, media_type: "image/png", path: "thumb.png" }],
      ome: {
        version: "0.5",
        multiscales: [
          {
            axes: [
              { name: "y", type: "space" },
              { name: "x", type: "space" }
            ],
            datasets: [{ path: "0" }]
          }
        ]
      }
    }
  });
  await writeJson(join(thumbed, "0", "zarr.json"), {
    zarr_format: 3,
    node_type: "array",
    shape: [16, 16],
    data_type: "uint8",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [16, 16] } },
    chunk_key_encoding: { name: "default" },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0
  });
  await fs.writeFile(join(root, "README.txt"), "not a dataset");
  await fs.mkdir(join(root, "__MACOSX"), { recursive: true });
  await fs.mkdir(join(root, ".hidden"), { recursive: true });
  await fs.writeFile(join(root, ".hidden", "secret"), "ignored");
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

// tests/node-handles.ts
import { promises as fs2 } from "node:fs";
import { join as join2 } from "node:path";
function notFound(name) {
  return new DOMException(`No entry named ${name}`, "NotFoundError");
}
function typeMismatch(name) {
  return new DOMException(`Entry ${name} is the wrong type`, "TypeMismatchError");
}
var NodeFileHandle = class {
  constructor(name, path) {
    this.name = name;
    this.path = path;
  }
  kind = "file";
  async getFile() {
    const [data, stat] = await Promise.all([fs2.readFile(this.path), fs2.stat(this.path)]);
    return new File([data], this.name, { lastModified: stat.mtimeMs });
  }
};
var NodeDirectoryHandle = class _NodeDirectoryHandle {
  constructor(name, path) {
    this.name = name;
    this.path = path;
  }
  kind = "directory";
  async getFileHandle(name) {
    const target = join2(this.path, name);
    let stat;
    try {
      stat = await fs2.stat(target);
    } catch {
      throw notFound(name);
    }
    if (!stat.isFile()) throw typeMismatch(name);
    return new NodeFileHandle(name, target);
  }
  async getDirectoryHandle(name) {
    const target = join2(this.path, name);
    let stat;
    try {
      stat = await fs2.stat(target);
    } catch {
      throw notFound(name);
    }
    if (!stat.isDirectory()) throw typeMismatch(name);
    return new _NodeDirectoryHandle(name, target);
  }
  async *values() {
    const entries = await fs2.readdir(this.path, { withFileTypes: true });
    for (const entry of entries) {
      const target = join2(this.path, entry.name);
      yield entry.isDirectory() ? new _NodeDirectoryHandle(entry.name, target) : new NodeFileHandle(entry.name, target);
    }
  }
  async *entries() {
    for await (const handle of this.values()) yield [handle.name, handle];
  }
  async *keys() {
    for await (const handle of this.values()) yield handle.name;
  }
  async queryPermission() {
    return "granted";
  }
  async requestPermission() {
    return "granted";
  }
};
function directoryHandle(path, name) {
  return new NodeDirectoryHandle(
    name ?? path.slice(path.lastIndexOf("/") + 1),
    path
  );
}

// tests/discovery.test.ts
var urlBuilder = (mountId, relativePath) => `https://example.test/_local/${mountId}/${relativePath}`;
function mountFor(path, name) {
  return { id: "m1", name, handle: directoryHandle(path, name), createdAt: 0 };
}
function byName(result, name) {
  const found = result.datasets.find((dataset) => dataset.name === name);
  assert.ok(found, `expected a dataset named ${name}, got ${result.datasets.map((d) => d.name).join(", ")}`);
  return found;
}
describe("OME-Zarr discovery", () => {
  let fixture;
  let result;
  before(async () => {
    fixture = await makeFixture();
    result = await discoverInMount(mountFor(fixture.root, "drop"), { urlBuilder });
  });
  after(async () => {
    await fixture.cleanup();
  });
  it("finds every multiscale image and nothing else", () => {
    assert.deepEqual(
      result.datasets.map((dataset) => dataset.relativePath).sort(),
      [
        "big-pyramid.ome.zarr",
        "nested/deeper/v3-image.ome.zarr",
        "plate.ome.zarr/A/1/0",
        "thumbed.ome.zarr",
        "v2-image.ome.zarr"
      ]
    );
  });
  it("never reports a dataset nested inside another dataset", () => {
    for (const outer of result.datasets) {
      for (const inner of result.datasets) {
        if (outer === inner) continue;
        assert.equal(
          inner.relativePath.startsWith(`${outer.relativePath}/`),
          false,
          `${inner.relativePath} is nested inside ${outer.relativePath}`
        );
      }
    }
  });
  it("stops at the multiscale root instead of walking its chunk tree", () => {
    assert.ok(
      result.directoriesScanned < 25,
      `scanned ${result.directoriesScanned} folders, expected the walk to stop at dataset roots`
    );
  });
  it("reads v2 metadata, including axes and array shape", () => {
    const dataset = byName(result, "v2-image");
    assert.equal(dataset.zarrFormat, 2);
    assert.equal(dataset.omeZarrVersion, "0.4");
    assert.deepEqual(dataset.axes, ["c", "y", "x"]);
    assert.deepEqual(dataset.shape, [2, 64, 64]);
    assert.equal(dataset.dtype, "<u2");
    assert.equal(dataset.scaleCount, 2);
  });
  it("reads v3 metadata nested under attributes.ome", () => {
    const dataset = byName(result, "v3-image");
    assert.equal(dataset.zarrFormat, 3);
    assert.equal(dataset.omeZarrVersion, "0.5");
    assert.deepEqual(dataset.axes, ["z", "y", "x"]);
    assert.deepEqual(dataset.shape, [8, 32, 32]);
    assert.equal(dataset.dtype, "uint8");
  });
  it("builds virtual URLs with a trailing slash", () => {
    for (const dataset of result.datasets) {
      assert.ok(dataset.virtualUrl.endsWith("/"), dataset.virtualUrl);
      assert.equal(dataset.virtualUrl, `${urlBuilder("m1", dataset.relativePath)}/`);
    }
  });
  it("walks into a plate and says so", () => {
    const note2 = result.notes.find((entry) => entry.path.endsWith("plate.ome.zarr"));
    assert.ok(note2, "expected a note about the plate");
    assert.equal(note2.kind, "skipped");
    assert.match(note2.message, /plate/i);
  });
  it("ignores a bare array without reporting it below the drop root", () => {
    assert.equal(
      result.datasets.some((dataset) => dataset.relativePath.includes("bare-array")),
      false
    );
    assert.equal(
      result.notes.some((note2) => note2.path.includes("bare-array")),
      false
    );
  });
  it("treats a dropped dataset root as a single dataset", async () => {
    const single = await discoverInMount(
      mountFor(join3(fixture.root, "v2-image.ome.zarr"), "v2-image.ome.zarr"),
      { urlBuilder }
    );
    assert.equal(single.datasets.length, 1);
    assert.equal(single.datasets[0].relativePath, "");
    assert.equal(single.datasets[0].name, "v2-image");
    assert.equal(single.datasets[0].virtualUrl, "https://example.test/_local/m1/");
  });
  it("reports a dropped bare array as unsupported", async () => {
    const single = await discoverInMount(
      mountFor(join3(fixture.root, "bare-array.zarr"), "bare-array.zarr"),
      { urlBuilder }
    );
    assert.equal(single.datasets.length, 0);
    assert.equal(single.notes.length, 1);
    assert.equal(single.notes[0].kind, "unsupported");
    assert.match(single.notes[0].message, /bare Zarr array/);
  });
  it("marks a dataset previewable when its coarsest level is small", () => {
    const dataset = byName(result, "v2-image");
    assert.equal(dataset.previewable, true);
    assert.equal(dataset.hasConventionThumbnail, false);
  });
  it("refuses a preview when the coarsest level is still huge", () => {
    const dataset = byName(result, "big-pyramid");
    assert.equal(dataset.previewable, false);
  });
  it("defers to a dataset that ships its own thumbnails", () => {
    const dataset = byName(result, "thumbed");
    assert.equal(dataset.hasConventionThumbnail, true);
    assert.equal(dataset.previewable, false);
  });
  it("honours the dataset limit and reports it", async () => {
    const limited = await discoverInMount(mountFor(fixture.root, "drop"), {
      urlBuilder,
      limits: { maxDatasets: 1 }
    });
    assert.equal(limited.datasets.length, 1);
    assert.ok(limited.notes.some((note2) => note2.kind === "limit"));
  });
  it("stops at the depth limit rather than walking forever", async () => {
    const shallow = await discoverInMount(mountFor(fixture.root, "drop"), {
      urlBuilder,
      limits: { maxDepth: 1 }
    });
    assert.deepEqual(
      shallow.datasets.map((dataset) => dataset.relativePath).sort(),
      ["big-pyramid.ome.zarr", "thumbed.ome.zarr", "v2-image.ome.zarr"]
    );
    assert.ok(shallow.notes.some((note2) => note2.kind === "limit"));
  });
  it("reports progress as it walks", async () => {
    const seen = [];
    await discoverInMount(mountFor(fixture.root, "drop"), {
      urlBuilder,
      onProgress: (progress) => seen.push(progress.directoriesScanned)
    });
    assert.ok(seen.length > 1);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvZGlzY292ZXJ5LnRlc3QudHMiLCAiLi4vc3JjL3Zmcy9wcm90b2NvbC50cyIsICIuLi9zcmMvdmZzL2NsaWVudC50cyIsICIuLi9zcmMvcHJldmlldy9wb2xpY3kudHMiLCAiLi4vc3JjL2Rpc2NvdmVyeS96YXJyLW1ldGFkYXRhLnRzIiwgIi4uL3NyYy9kaXNjb3ZlcnkvdHlwZXMudHMiLCAiLi4vc3JjL2Rpc2NvdmVyeS9kaXNjb3Zlci50cyIsICIuLi90ZXN0cy9maXh0dXJlcy50cyIsICIuLi90ZXN0cy9ub2RlLWhhbmRsZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IGFmdGVyLCBiZWZvcmUsIGRlc2NyaWJlLCBpdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuaW1wb3J0IHsgZGlzY292ZXJJbk1vdW50IH0gZnJvbSAnLi4vc3JjL2Rpc2NvdmVyeS9kaXNjb3Zlcic7XG5pbXBvcnQgdHlwZSB7IERpc2NvdmVyZWREYXRhc2V0LCBEaXNjb3ZlcnlSZXN1bHQgfSBmcm9tICcuLi9zcmMvZGlzY292ZXJ5L3R5cGVzJztcbmltcG9ydCB0eXBlIHsgTW91bnQgfSBmcm9tICcuLi9zcmMvbW91bnRzL3JlZ2lzdHJ5JztcbmltcG9ydCB7IG1ha2VGaXh0dXJlLCB0eXBlIEZpeHR1cmUgfSBmcm9tICcuL2ZpeHR1cmVzJztcbmltcG9ydCB7IGRpcmVjdG9yeUhhbmRsZSB9IGZyb20gJy4vbm9kZS1oYW5kbGVzJztcblxuY29uc3QgdXJsQnVpbGRlciA9IChtb3VudElkOiBzdHJpbmcsIHJlbGF0aXZlUGF0aDogc3RyaW5nKSA9PlxuICBgaHR0cHM6Ly9leGFtcGxlLnRlc3QvX2xvY2FsLyR7bW91bnRJZH0vJHtyZWxhdGl2ZVBhdGh9YDtcblxuZnVuY3Rpb24gbW91bnRGb3IocGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBNb3VudCB7XG4gIHJldHVybiB7IGlkOiAnbTEnLCBuYW1lLCBoYW5kbGU6IGRpcmVjdG9yeUhhbmRsZShwYXRoLCBuYW1lKSwgY3JlYXRlZEF0OiAwIH07XG59XG5cbmZ1bmN0aW9uIGJ5TmFtZShyZXN1bHQ6IERpc2NvdmVyeVJlc3VsdCwgbmFtZTogc3RyaW5nKTogRGlzY292ZXJlZERhdGFzZXQge1xuICBjb25zdCBmb3VuZCA9IHJlc3VsdC5kYXRhc2V0cy5maW5kKChkYXRhc2V0KSA9PiBkYXRhc2V0Lm5hbWUgPT09IG5hbWUpO1xuICBhc3NlcnQub2soZm91bmQsIGBleHBlY3RlZCBhIGRhdGFzZXQgbmFtZWQgJHtuYW1lfSwgZ290ICR7cmVzdWx0LmRhdGFzZXRzLm1hcCgoZCkgPT4gZC5uYW1lKS5qb2luKCcsICcpfWApO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmRlc2NyaWJlKCdPTUUtWmFyciBkaXNjb3ZlcnknLCAoKSA9PiB7XG4gIGxldCBmaXh0dXJlOiBGaXh0dXJlO1xuICBsZXQgcmVzdWx0OiBEaXNjb3ZlcnlSZXN1bHQ7XG5cbiAgYmVmb3JlKGFzeW5jICgpID0+IHtcbiAgICBmaXh0dXJlID0gYXdhaXQgbWFrZUZpeHR1cmUoKTtcbiAgICByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQobW91bnRGb3IoZml4dHVyZS5yb290LCAnZHJvcCcpLCB7IHVybEJ1aWxkZXIgfSk7XG4gIH0pO1xuXG4gIGFmdGVyKGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBmaXh0dXJlLmNsZWFudXAoKTtcbiAgfSk7XG5cbiAgaXQoJ2ZpbmRzIGV2ZXJ5IG11bHRpc2NhbGUgaW1hZ2UgYW5kIG5vdGhpbmcgZWxzZScsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgcmVzdWx0LmRhdGFzZXRzLm1hcCgoZGF0YXNldCkgPT4gZGF0YXNldC5yZWxhdGl2ZVBhdGgpLnNvcnQoKSxcbiAgICAgIFtcbiAgICAgICAgJ2JpZy1weXJhbWlkLm9tZS56YXJyJyxcbiAgICAgICAgJ25lc3RlZC9kZWVwZXIvdjMtaW1hZ2Uub21lLnphcnInLFxuICAgICAgICAncGxhdGUub21lLnphcnIvQS8xLzAnLFxuICAgICAgICAndGh1bWJlZC5vbWUuemFycicsXG4gICAgICAgICd2Mi1pbWFnZS5vbWUuemFycicsXG4gICAgICBdLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCduZXZlciByZXBvcnRzIGEgZGF0YXNldCBuZXN0ZWQgaW5zaWRlIGFub3RoZXIgZGF0YXNldCcsICgpID0+IHtcbiAgICAvLyBUaGUgdjIgaW1hZ2UgaGFzIGxldmVscyBgMGAgYW5kIGAxYCwgZWFjaCBhIFphcnIgYXJyYXkgd2l0aCBjaHVua1xuICAgIC8vIGRpcmVjdG9yaWVzIGJlbG93IGl0OyBub25lIG1heSBzdXJmYWNlIGFzIGEgZGF0YXNldCBvZiBpdHMgb3duLiBUZXN0aW5nXG4gICAgLy8gY29udGFpbm1lbnQgcmF0aGVyIHRoYW4gcGF0aCBzaGFwZSBhbHNvIGNvdmVycyBhIHBsYXRlJ3MgZmllbGRzIG9mIHZpZXcsXG4gICAgLy8gd2hpY2ggbGVnaXRpbWF0ZWx5IHNpdCBhdCBwYXRocyBsaWtlIGBBLzEvMGAuXG4gICAgZm9yIChjb25zdCBvdXRlciBvZiByZXN1bHQuZGF0YXNldHMpIHtcbiAgICAgIGZvciAoY29uc3QgaW5uZXIgb2YgcmVzdWx0LmRhdGFzZXRzKSB7XG4gICAgICAgIGlmIChvdXRlciA9PT0gaW5uZXIpIGNvbnRpbnVlO1xuICAgICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgICAgaW5uZXIucmVsYXRpdmVQYXRoLnN0YXJ0c1dpdGgoYCR7b3V0ZXIucmVsYXRpdmVQYXRofS9gKSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBgJHtpbm5lci5yZWxhdGl2ZVBhdGh9IGlzIG5lc3RlZCBpbnNpZGUgJHtvdXRlci5yZWxhdGl2ZVBhdGh9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdzdG9wcyBhdCB0aGUgbXVsdGlzY2FsZSByb290IGluc3RlYWQgb2Ygd2Fsa2luZyBpdHMgY2h1bmsgdHJlZScsICgpID0+IHtcbiAgICAvLyAxMiBmb2xkZXJzOiB0aGUgZHJvcCByb290LCB0aHJlZSBkYXRhc2V0IHJvb3RzLCBhbmQgdGhlIHBsYWluIGZvbGRlcnNcbiAgICAvLyBsZWFkaW5nIHRvIHRoZW0uIElmIHRoZSB3YWxrIGRlc2NlbmRlZCBpbnRvIHJlc29sdXRpb24gbGV2ZWxzIG9yIGNodW5rXG4gICAgLy8gZGlyZWN0b3JpZXMgdGhpcyBudW1iZXIgd291bGQgYmUgZmFyIGxhcmdlci5cbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuZGlyZWN0b3JpZXNTY2FubmVkIDwgMjUsXG4gICAgICBgc2Nhbm5lZCAke3Jlc3VsdC5kaXJlY3Rvcmllc1NjYW5uZWR9IGZvbGRlcnMsIGV4cGVjdGVkIHRoZSB3YWxrIHRvIHN0b3AgYXQgZGF0YXNldCByb290c2AsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ3JlYWRzIHYyIG1ldGFkYXRhLCBpbmNsdWRpbmcgYXhlcyBhbmQgYXJyYXkgc2hhcGUnLCAoKSA9PiB7XG4gICAgY29uc3QgZGF0YXNldCA9IGJ5TmFtZShyZXN1bHQsICd2Mi1pbWFnZScpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhc2V0LnphcnJGb3JtYXQsIDIpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhc2V0Lm9tZVphcnJWZXJzaW9uLCAnMC40Jyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChkYXRhc2V0LmF4ZXMsIFsnYycsICd5JywgJ3gnXSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChkYXRhc2V0LnNoYXBlLCBbMiwgNjQsIDY0XSk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQuZHR5cGUsICc8dTInKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5zY2FsZUNvdW50LCAyKTtcbiAgfSk7XG5cbiAgaXQoJ3JlYWRzIHYzIG1ldGFkYXRhIG5lc3RlZCB1bmRlciBhdHRyaWJ1dGVzLm9tZScsICgpID0+IHtcbiAgICBjb25zdCBkYXRhc2V0ID0gYnlOYW1lKHJlc3VsdCwgJ3YzLWltYWdlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQuemFyckZvcm1hdCwgMyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQub21lWmFyclZlcnNpb24sICcwLjUnKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRhdGFzZXQuYXhlcywgWyd6JywgJ3knLCAneCddKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRhdGFzZXQuc2hhcGUsIFs4LCAzMiwgMzJdKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5kdHlwZSwgJ3VpbnQ4Jyk7XG4gIH0pO1xuXG4gIGl0KCdidWlsZHMgdmlydHVhbCBVUkxzIHdpdGggYSB0cmFpbGluZyBzbGFzaCcsICgpID0+IHtcbiAgICBmb3IgKGNvbnN0IGRhdGFzZXQgb2YgcmVzdWx0LmRhdGFzZXRzKSB7XG4gICAgICBhc3NlcnQub2soZGF0YXNldC52aXJ0dWFsVXJsLmVuZHNXaXRoKCcvJyksIGRhdGFzZXQudmlydHVhbFVybCk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC52aXJ0dWFsVXJsLCBgJHt1cmxCdWlsZGVyKCdtMScsIGRhdGFzZXQucmVsYXRpdmVQYXRoKX0vYCk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnd2Fsa3MgaW50byBhIHBsYXRlIGFuZCBzYXlzIHNvJywgKCkgPT4ge1xuICAgIGNvbnN0IG5vdGUgPSByZXN1bHQubm90ZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LnBhdGguZW5kc1dpdGgoJ3BsYXRlLm9tZS56YXJyJykpO1xuICAgIGFzc2VydC5vayhub3RlLCAnZXhwZWN0ZWQgYSBub3RlIGFib3V0IHRoZSBwbGF0ZScpO1xuICAgIGFzc2VydC5lcXVhbChub3RlLmtpbmQsICdza2lwcGVkJyk7XG4gICAgYXNzZXJ0Lm1hdGNoKG5vdGUubWVzc2FnZSwgL3BsYXRlL2kpO1xuICB9KTtcblxuICBpdCgnaWdub3JlcyBhIGJhcmUgYXJyYXkgd2l0aG91dCByZXBvcnRpbmcgaXQgYmVsb3cgdGhlIGRyb3Agcm9vdCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQuZGF0YXNldHMuc29tZSgoZGF0YXNldCkgPT4gZGF0YXNldC5yZWxhdGl2ZVBhdGguaW5jbHVkZXMoJ2JhcmUtYXJyYXknKSksXG4gICAgICBmYWxzZSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdC5ub3Rlcy5zb21lKChub3RlKSA9PiBub3RlLnBhdGguaW5jbHVkZXMoJ2JhcmUtYXJyYXknKSksXG4gICAgICBmYWxzZSxcbiAgICApO1xuICB9KTtcblxuICBpdCgndHJlYXRzIGEgZHJvcHBlZCBkYXRhc2V0IHJvb3QgYXMgYSBzaW5nbGUgZGF0YXNldCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzaW5nbGUgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQoXG4gICAgICBtb3VudEZvcihqb2luKGZpeHR1cmUucm9vdCwgJ3YyLWltYWdlLm9tZS56YXJyJyksICd2Mi1pbWFnZS5vbWUuemFycicpLFxuICAgICAgeyB1cmxCdWlsZGVyIH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoc2luZ2xlLmRhdGFzZXRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNpbmdsZS5kYXRhc2V0c1swXS5yZWxhdGl2ZVBhdGgsICcnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2luZ2xlLmRhdGFzZXRzWzBdLm5hbWUsICd2Mi1pbWFnZScpO1xuICAgIGFzc2VydC5lcXVhbChzaW5nbGUuZGF0YXNldHNbMF0udmlydHVhbFVybCwgJ2h0dHBzOi8vZXhhbXBsZS50ZXN0L19sb2NhbC9tMS8nKTtcbiAgfSk7XG5cbiAgaXQoJ3JlcG9ydHMgYSBkcm9wcGVkIGJhcmUgYXJyYXkgYXMgdW5zdXBwb3J0ZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2luZ2xlID0gYXdhaXQgZGlzY292ZXJJbk1vdW50KFxuICAgICAgbW91bnRGb3Ioam9pbihmaXh0dXJlLnJvb3QsICdiYXJlLWFycmF5LnphcnInKSwgJ2JhcmUtYXJyYXkuemFycicpLFxuICAgICAgeyB1cmxCdWlsZGVyIH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoc2luZ2xlLmRhdGFzZXRzLmxlbmd0aCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNpbmdsZS5ub3Rlcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChzaW5nbGUubm90ZXNbMF0ua2luZCwgJ3Vuc3VwcG9ydGVkJyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHNpbmdsZS5ub3Rlc1swXS5tZXNzYWdlLCAvYmFyZSBaYXJyIGFycmF5Lyk7XG4gIH0pO1xuXG4gIGl0KCdtYXJrcyBhIGRhdGFzZXQgcHJldmlld2FibGUgd2hlbiBpdHMgY29hcnNlc3QgbGV2ZWwgaXMgc21hbGwnLCAoKSA9PiB7XG4gICAgLy8gdjItaW1hZ2UgYm90dG9tcyBvdXQgYXQgMiB4IDMyIHggMzIuXG4gICAgY29uc3QgZGF0YXNldCA9IGJ5TmFtZShyZXN1bHQsICd2Mi1pbWFnZScpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhc2V0LnByZXZpZXdhYmxlLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5oYXNDb252ZW50aW9uVGh1bWJuYWlsLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KCdyZWZ1c2VzIGEgcHJldmlldyB3aGVuIHRoZSBjb2Fyc2VzdCBsZXZlbCBpcyBzdGlsbCBodWdlJywgKCkgPT4ge1xuICAgIC8vIDgxOTIgeCA4MTkyIGV4Y2VlZHMgYm90aCB0aGUgZWxlbWVudCBidWRnZXQgYW5kIHRoZSBleHRlbnQgY2FwLCBhbmQgdGhlXG4gICAgLy8ganVkZ2VtZW50IGlzIG1hZGUgZnJvbSBtZXRhZGF0YSBhbG9uZSBcdTIwMTQgbm8gY2h1bmsgaXMgcmVhZC5cbiAgICBjb25zdCBkYXRhc2V0ID0gYnlOYW1lKHJlc3VsdCwgJ2JpZy1weXJhbWlkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQucHJldmlld2FibGUsIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ2RlZmVycyB0byBhIGRhdGFzZXQgdGhhdCBzaGlwcyBpdHMgb3duIHRodW1ibmFpbHMnLCAoKSA9PiB7XG4gICAgY29uc3QgZGF0YXNldCA9IGJ5TmFtZShyZXN1bHQsICd0aHVtYmVkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQuaGFzQ29udmVudGlvblRodW1ibmFpbCwgdHJ1ZSk7XG4gICAgLy8gTm8gcHJldmlldyBuZWVkZWQ6IFphcnJjYWRlIHJlYWRzIHRoZSBjb252ZW50aW9uIGl0c2VsZi5cbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5wcmV2aWV3YWJsZSwgZmFsc2UpO1xuICB9KTtcblxuICBpdCgnaG9ub3VycyB0aGUgZGF0YXNldCBsaW1pdCBhbmQgcmVwb3J0cyBpdCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBsaW1pdGVkID0gYXdhaXQgZGlzY292ZXJJbk1vdW50KG1vdW50Rm9yKGZpeHR1cmUucm9vdCwgJ2Ryb3AnKSwge1xuICAgICAgdXJsQnVpbGRlcixcbiAgICAgIGxpbWl0czogeyBtYXhEYXRhc2V0czogMSB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChsaW1pdGVkLmRhdGFzZXRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKGxpbWl0ZWQubm90ZXMuc29tZSgobm90ZSkgPT4gbm90ZS5raW5kID09PSAnbGltaXQnKSk7XG4gIH0pO1xuXG4gIGl0KCdzdG9wcyBhdCB0aGUgZGVwdGggbGltaXQgcmF0aGVyIHRoYW4gd2Fsa2luZyBmb3JldmVyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNoYWxsb3cgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQobW91bnRGb3IoZml4dHVyZS5yb290LCAnZHJvcCcpLCB7XG4gICAgICB1cmxCdWlsZGVyLFxuICAgICAgbGltaXRzOiB7IG1heERlcHRoOiAxIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHNoYWxsb3cuZGF0YXNldHMubWFwKChkYXRhc2V0KSA9PiBkYXRhc2V0LnJlbGF0aXZlUGF0aCkuc29ydCgpLFxuICAgICAgWydiaWctcHlyYW1pZC5vbWUuemFycicsICd0aHVtYmVkLm9tZS56YXJyJywgJ3YyLWltYWdlLm9tZS56YXJyJ10sXG4gICAgKTtcbiAgICBhc3NlcnQub2soc2hhbGxvdy5ub3Rlcy5zb21lKChub3RlKSA9PiBub3RlLmtpbmQgPT09ICdsaW1pdCcpKTtcbiAgfSk7XG5cbiAgaXQoJ3JlcG9ydHMgcHJvZ3Jlc3MgYXMgaXQgd2Fsa3MnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2VlbjogbnVtYmVyW10gPSBbXTtcbiAgICBhd2FpdCBkaXNjb3ZlckluTW91bnQobW91bnRGb3IoZml4dHVyZS5yb290LCAnZHJvcCcpLCB7XG4gICAgICB1cmxCdWlsZGVyLFxuICAgICAgb25Qcm9ncmVzczogKHByb2dyZXNzKSA9PiBzZWVuLnB1c2gocHJvZ3Jlc3MuZGlyZWN0b3JpZXNTY2FubmVkKSxcbiAgICB9KTtcbiAgICBhc3NlcnQub2soc2Vlbi5sZW5ndGggPiAxKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHNlZW4sIFsuLi5zZWVuXS5zb3J0KChhLCBiKSA9PiBhIC0gYikpO1xuICB9KTtcbn0pO1xuIiwgIi8qKlxuICogQ29udHJhY3Qgc2hhcmVkIGJ5IHRoZSBwYWdlIGFuZCB0aGUgc2VydmljZSB3b3JrZXIuXG4gKlxuICogQm90aCBzaWRlcyBydW4gaW4gdGhlIHNhbWUgb3JpZ2luIGJ1dCBpbiBkaWZmZXJlbnQgSlMgcmVhbG1zLCBzbyBldmVyeXRoaW5nXG4gKiB0aGV5IGFncmVlIG9uIFx1MjAxNCBJbmRleGVkREIgbmFtZXMsIFVSTCBwcmVmaXhlcywgbWVzc2FnZSBzaGFwZXMgXHUyMDE0IGxpdmVzIGhlcmUuXG4gKi9cblxuLyoqXG4gKiBWaXJ0dWFsIG5hbWVzcGFjZSBzZWdtZW50cywgYXBwZW5kZWQgdG8gdGhlIGRlcGxveW1lbnQgYmFzZSBwYXRoLlxuICpcbiAqIFRoZSBiYXNlIGlzIG5vdCBhIGNvbnN0YW50OiB0aGUgcG9ydGFsIGlzIGJ1aWx0IHdpdGggYSByZWxhdGl2ZSBiYXNlIHNvIHRoZVxuICogc2FtZSBidW5kbGUgcnVucyBhdCBhbiBvcmlnaW4gcm9vdCBhbmQgYXQgYSBHaXRIdWIgUGFnZXMgcHJvamVjdCBzdWJwYXRoXG4gKiAoYC88cmVwbz4vYCkuIEEgc2VydmljZSB3b3JrZXIgY2FuIG9ubHkgY2xhaW0gYSBzY29wZSBhdCBvciBiZWxvdyBpdHMgb3duXG4gKiBwYXRoLCBzbyBhdCBgLzxyZXBvPi9gIHRoZSBuYW1lc3BhY2UgaXMgYC88cmVwbz4vX2xvY2FsLy4uLmAuIEJvdGggc2lkZXNcbiAqIGRlcml2ZSB0aGUgYmFzZSBhdCBydW50aW1lIFx1MjAxNCB0aGUgd29ya2VyIGZyb20gaXRzIHJlZ2lzdHJhdGlvbiBzY29wZSwgdGhlXG4gKiBwYWdlIGZyb20gdGhlIHNhbWUgc2NvcGUgb25jZSByZWdpc3RlcmVkIFx1MjAxNCBhbmQgam9pbiB0aGVzZSBzZWdtZW50cyBvbnRvIGl0LlxuICovXG5leHBvcnQgY29uc3QgTE9DQUxfU0VHTUVOVCA9ICdfbG9jYWwnO1xuZXhwb3J0IGNvbnN0IFNFU1NJT05fU0VHTUVOVCA9ICdfc2Vzc2lvbic7XG4vKipcbiAqIERlcml2ZWQgcHJldmlldyBpbWFnZXMsIHJlbmRlcmVkIG9uIGRlbWFuZCBmcm9tIGEgZGF0YXNldCdzIGNvYXJzZXN0XG4gKiBweXJhbWlkIGxldmVsLiBLZXB0IG91dCBvZiBgX2xvY2FsL2AsIHdoaWNoIGlzIGEgZmFpdGhmdWwgbWlycm9yIG9mIHdoYXQgaXNcbiAqIGFjdHVhbGx5IG9uIGRpc2suXG4gKi9cbmV4cG9ydCBjb25zdCBQUkVWSUVXX1NFR01FTlQgPSAnX3ByZXZpZXcnO1xuXG4vKiogSm9pbiBhIGJhc2UgcGF0aCAod2l0aCB0cmFpbGluZyBzbGFzaCkgYW5kIGEgbmFtZXNwYWNlIHNlZ21lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gbmFtZXNwYWNlUHJlZml4KGJhc2VQYXRoOiBzdHJpbmcsIHNlZ21lbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtiYXNlUGF0aH0ke3NlZ21lbnR9L2A7XG59XG5cbmV4cG9ydCBjb25zdCBEQl9OQU1FID0gJ29tZS16YXJyLXBvcnRhbCc7XG5leHBvcnQgY29uc3QgREJfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgTU9VTlRfU1RPUkUgPSAnbW91bnRzJztcbmV4cG9ydCBjb25zdCBTRVNTSU9OX1NUT1JFID0gJ3Nlc3Npb25GaWxlcyc7XG5cbi8qKlxuICogQSBtb3VudGVkIGxvY2FsIGRpcmVjdG9yeS5cbiAqXG4gKiBgaGFuZGxlYCBpcyBhIGxpdmUgYEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVgLiBCb3RoIEluZGV4ZWREQiBhbmRcbiAqIGBwb3N0TWVzc2FnZWAgY2FuIGNhcnJ5IHRoZXNlIGJ5IHN0cnVjdHVyZWQgY2xvbmUsIHdoaWNoIGlzIHdoYXQgbGV0cyB0aGVcbiAqIHNlcnZpY2Ugd29ya2VyIHJlYWQgdGhlIHVzZXIncyBmaWxlcyBkaXJlY3RseSBpbnN0ZWFkIG9mIHByb3h5aW5nIGV2ZXJ5XG4gKiBieXRlIHRocm91Z2ggdGhlIHBhZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTW91bnRSZWNvcmQge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGhhbmRsZTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG59XG5cbi8qKiBBIGdlbmVyYXRlZCBkb2N1bWVudCBzZXJ2ZWQgdW5kZXIgdGhlIGBfc2Vzc2lvbi9gIG5hbWVzcGFjZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbkZpbGVSZWNvcmQge1xuICAvKiogYCR7c2Vzc2lvbklkfS8ke3BhdGh9YCBcdTIwMTQgdGhlIEluZGV4ZWREQiBrZXkuICovXG4gIGtleTogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcGF0aDogc3RyaW5nO1xuICBib2R5OiBzdHJpbmc7XG4gIGNvbnRlbnRUeXBlOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xufVxuXG4vKiogTWVzc2FnZXMgdGhlIHBhZ2Ugc2VuZHMgdG8gdGhlIHNlcnZpY2Ugd29ya2VyLiAqL1xuZXhwb3J0IHR5cGUgUG9ydGFsTWVzc2FnZSA9XG4gIHwgeyB0eXBlOiAncGluZycgfVxuICB8IHsgdHlwZTogJ2ZsdXNoJzsgbW91bnRJZD86IHN0cmluZyB9O1xuXG4vKiogQnVtcGVkIHdoZW4gdGhlIHdvcmtlcidzIGJlaGF2aW91ciBjaGFuZ2VzLCBmb3IgZGVidWdnaW5nLiAqL1xuZXhwb3J0IGNvbnN0IFNXX1ZFUlNJT04gPSAnMSc7XG4iLCAiLyoqXG4gKiBQYWdlLXNpZGUgaGFsZiBvZiB0aGUgdmlydHVhbCBmaWxlc3lzdGVtOiByZWdpc3RlcnMgdGhlIHNlcnZpY2Ugd29ya2VyIGFuZFxuICogd3JpdGVzIHRoZSByZWNvcmRzIGl0IHJlYWRzLlxuICovXG5pbXBvcnQgeyBpZGJEZWxldGUsIGlkYkdldEFsbCwgaWRiUHV0IH0gZnJvbSAnLi9pZGInO1xuaW1wb3J0IHtcbiAgTE9DQUxfU0VHTUVOVCxcbiAgbmFtZXNwYWNlUHJlZml4LFxuICBQUkVWSUVXX1NFR01FTlQsXG4gIFNFU1NJT05fU0VHTUVOVCxcbiAgU0VTU0lPTl9TVE9SRSxcbiAgdHlwZSBQb3J0YWxNZXNzYWdlLFxuICB0eXBlIFNlc3Npb25GaWxlUmVjb3JkLFxufSBmcm9tICcuL3Byb3RvY29sJztcblxuZXhwb3J0IGNsYXNzIFNlcnZpY2VXb3JrZXJVbmF2YWlsYWJsZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxubGV0IHJlZ2lzdHJhdGlvbjogUHJvbWlzZTxTZXJ2aWNlV29ya2VyUmVnaXN0cmF0aW9uPiB8IG51bGwgPSBudWxsO1xubGV0IGJhc2VQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBUaGUgcGF0aCB0aGUgcG9ydGFsIGlzIGRlcGxveWVkIHVuZGVyLCBhbHdheXMgd2l0aCBhIHRyYWlsaW5nIHNsYXNoIFx1MjAxNCBgL2BcbiAqIGxvY2FsbHksIGAvPHJlcG8+L2Agb24gYSBHaXRIdWIgUGFnZXMgcHJvamVjdCBzaXRlLlxuICpcbiAqIE9uY2UgdGhlIHdvcmtlciBpcyByZWdpc3RlcmVkIHRoaXMgaXMgaXRzIHNjb3BlLCB3aGljaCBpcyBhdXRob3JpdGF0aXZlOlxuICogVVJMcyBidWlsdCBmcm9tIGFueSBvdGhlciB2YWx1ZSB3b3VsZCBub3QgYmUgaW50ZXJjZXB0ZWQuIEJlZm9yZSB0aGF0LCBmYWxsXG4gKiBiYWNrIHRvIHRoZSBsYW5kaW5nIHBhZ2UncyBvd24gZGlyZWN0b3J5LCB3aGljaCBpcyB0aGUgc2FtZSB0aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEJhc2VQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiBiYXNlUGF0aCA/PyBuZXcgVVJMKCcuLycsIGxvY2F0aW9uLmhyZWYpLnBhdGhuYW1lO1xufVxuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSB3b3JrZXIgYW5kIHJlc29sdmUgb25jZSBpdCBhY3R1YWxseSBjb250cm9scyB0aGlzIHBhZ2UuXG4gKlxuICogQ29udHJvbGxpbmcgbWF0dGVyczogYW4gdW5jb250cm9sbGVkIHBhZ2UncyBgL19sb2NhbC9gIHJlcXVlc3RzIHdvdWxkIGZhbGxcbiAqIHRocm91Z2ggdG8gdGhlIG5ldHdvcmsgYW5kIDQwNC4gVGhlIHdvcmtlciBjYWxscyBgY2xpZW50cy5jbGFpbSgpYCBvblxuICogYWN0aXZhdGlvbiwgc28gYSBmaXJzdC12aXNpdCBwYWdlIGJlY29tZXMgY29udHJvbGxlZCB3aXRob3V0IGEgcmVsb2FkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlU2VydmljZVdvcmtlcigpOiBQcm9taXNlPFNlcnZpY2VXb3JrZXJSZWdpc3RyYXRpb24+IHtcbiAgaWYgKHJlZ2lzdHJhdGlvbikgcmV0dXJuIHJlZ2lzdHJhdGlvbjtcblxuICByZWdpc3RyYXRpb24gPSAoYXN5bmMgKCkgPT4ge1xuICAgIGlmICghKCdzZXJ2aWNlV29ya2VyJyBpbiBuYXZpZ2F0b3IpKSB7XG4gICAgICB0aHJvdyBuZXcgU2VydmljZVdvcmtlclVuYXZhaWxhYmxlRXJyb3IoXG4gICAgICAgICdUaGlzIGJyb3dzZXIgaGFzIG5vIFNlcnZpY2UgV29ya2VyIHN1cHBvcnQsIHdoaWNoIHRoZSBwb3J0YWwgbmVlZHMgdG8gZXhwb3NlIGxvY2FsIGZpbGVzLicsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIXdpbmRvdy5pc1NlY3VyZUNvbnRleHQpIHtcbiAgICAgIHRocm93IG5ldyBTZXJ2aWNlV29ya2VyVW5hdmFpbGFibGVFcnJvcihcbiAgICAgICAgJ1NlcnZpY2UgV29ya2VycyByZXF1aXJlIGEgc2VjdXJlIGNvbnRleHQuIFVzZSBodHRwOi8vbG9jYWxob3N0IG9yIGFuIGh0dHBzOi8vIG9yaWdpbi4nLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBSZWdpc3RlcmVkIHJlbGF0aXZlIHRvIHRoaXMgcGFnZSwgd2hpY2ggbGl2ZXMgYXQgdGhlIGRlcGxveW1lbnQgcm9vdC5cbiAgICAvLyBUaGF0IHJlc29sdmVzIHRvIGAvc3cuanNgIGxvY2FsbHkgYW5kIGAvPHJlcG8+L3N3LmpzYCBvbiBHaXRIdWIgUGFnZXMsXG4gICAgLy8gYW5kIHRoZSBkZWZhdWx0IHNjb3BlIGlzIHRoZSB3b3JrZXIncyBvd24gZGlyZWN0b3J5IGluIGJvdGggY2FzZXMgXHUyMDE0IHNvXG4gICAgLy8gbm8gYnVpbGQtdGltZSBrbm93bGVkZ2Ugb2YgdGhlIGRlcGxveW1lbnQgcGF0aCBpcyBuZWVkZWQuIEluIGRldiwgYSBWaXRlXG4gICAgLy8gbWlkZGxld2FyZSBzZXJ2ZXMgdGhlIHRyYW5zZm9ybWVkIHdvcmtlciBhdCB0aGUgc2FtZSBVUkwuXG4gICAgY29uc3QgcmVnID0gYXdhaXQgbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIucmVnaXN0ZXIoXG4gICAgICBuZXcgVVJMKCcuL3N3LmpzJywgbmV3IFVSTCgnLi8nLCBsb2NhdGlvbi5ocmVmKSksXG4gICAgICB7IHR5cGU6ICdtb2R1bGUnIH0sXG4gICAgKTtcbiAgICBiYXNlUGF0aCA9IG5ldyBVUkwocmVnLnNjb3BlKS5wYXRobmFtZTtcbiAgICBhd2FpdCBuYXZpZ2F0b3Iuc2VydmljZVdvcmtlci5yZWFkeTtcblxuICAgIGlmICghbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIuY29udHJvbGxlcikge1xuICAgICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMDApO1xuICAgICAgICBuYXZpZ2F0b3Iuc2VydmljZVdvcmtlci5hZGRFdmVudExpc3RlbmVyKFxuICAgICAgICAgICdjb250cm9sbGVyY2hhbmdlJyxcbiAgICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgeyBvbmNlOiB0cnVlIH0sXG4gICAgICAgICk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJlZztcbiAgfSkoKTtcblxuICByZWdpc3RyYXRpb24uY2F0Y2goKCkgPT4ge1xuICAgIC8vIEFsbG93IGEgbGF0ZXIgcmV0cnkgcmF0aGVyIHRoYW4gY2FjaGluZyB0aGUgZmFpbHVyZSBmb3JldmVyLlxuICAgIHJlZ2lzdHJhdGlvbiA9IG51bGw7XG4gIH0pO1xuXG4gIHJldHVybiByZWdpc3RyYXRpb247XG59XG5cbi8qKiBUZWxsIHRoZSB3b3JrZXIgdG8gZm9yZ2V0IGNhY2hlZCBoYW5kbGVzIGZvciBhIG1vdW50IChvciBhbGwgb2YgdGhlbSkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmx1c2hXb3JrZXIobW91bnRJZD86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjb250cm9sbGVyID0gbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXI/LmNvbnRyb2xsZXI7XG4gIGlmICghY29udHJvbGxlcikgcmV0dXJuO1xuICBjb25zdCBtZXNzYWdlOiBQb3J0YWxNZXNzYWdlID0geyB0eXBlOiAnZmx1c2gnLCBtb3VudElkIH07XG4gIGNvbnRyb2xsZXIucG9zdE1lc3NhZ2UobWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIGVuY29kZVBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHBhdGguc3BsaXQoJy8nKS5maWx0ZXIoQm9vbGVhbikubWFwKGVuY29kZVVSSUNvbXBvbmVudCkuam9pbignLycpO1xufVxuXG4vKipcbiAqIEFic29sdXRlIFVSTCBmb3IgYSBwYXRoIGluc2lkZSBhIG1vdW50LCBlLmcuXG4gKiBgaHR0cHM6Ly9ob3N0L19sb2NhbC9hYjEyL3NhbXBsZS5vbWUuemFyci8wL2MvMC8wLzBgLlxuICpcbiAqIFNlZ21lbnRzIGFyZSBlbmNvZGVkIGluZGl2aWR1YWxseSBzbyB0aGF0IHNwYWNlcyBhbmQgb3RoZXIgY2hhcmFjdGVycyB0aGF0XG4gKiBhcmUgbGVnYWwgaW4gZmlsZSBuYW1lcyBzdXJ2aXZlIHRoZSByb3VuZCB0cmlwLCB3aGlsZSBgL2Aga2VlcHMgaXRzIG1lYW5pbmdcbiAqIGFzIGEgc2VwYXJhdG9yLiBXaXRoIG5vIHJlbGF0aXZlIHBhdGggdGhpcyByZXR1cm5zIHRoZSBtb3VudCByb290LCB3aXRoIGFcbiAqIHRyYWlsaW5nIHNsYXNoIFx1MjAxNCB0aGUgZm9ybSBaYXJyIHNvdXJjZXMgZXhwZWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxVcmwobW91bnRJZDogc3RyaW5nLCByZWxhdGl2ZVBhdGggPSAnJyk6IHN0cmluZyB7XG4gIGNvbnN0IHByZWZpeCA9IG5hbWVzcGFjZVByZWZpeChnZXRCYXNlUGF0aCgpLCBMT0NBTF9TRUdNRU5UKTtcbiAgcmV0dXJuIG5ldyBVUkwoXG4gICAgYCR7cHJlZml4fSR7ZW5jb2RlVVJJQ29tcG9uZW50KG1vdW50SWQpfS8ke2VuY29kZVBhdGgocmVsYXRpdmVQYXRoKX1gLFxuICAgIGxvY2F0aW9uLm9yaWdpbixcbiAgKS5ocmVmO1xufVxuXG4vKipcbiAqIEFic29sdXRlIFVSTCBvZiBhIGRhdGFzZXQncyBnZW5lcmF0ZWQgcHJldmlldyBpbWFnZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgb3V0c2lkZSBgX2xvY2FsL2AsIHdoaWNoIG1pcnJvcnMgd2hhdCBpcyBhY3R1YWxseSBvbiBkaXNrO1xuICogYSBwcmV2aWV3IGlzIGRlcml2ZWQsIG5vdCBhIGZpbGUgdGhlIHVzZXIgaGFzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJldmlld1VybChtb3VudElkOiBzdHJpbmcsIHJlbGF0aXZlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcHJlZml4ID0gbmFtZXNwYWNlUHJlZml4KGdldEJhc2VQYXRoKCksIFBSRVZJRVdfU0VHTUVOVCk7XG4gIHJldHVybiBuZXcgVVJMKFxuICAgIGAke3ByZWZpeH0ke2VuY29kZVVSSUNvbXBvbmVudChtb3VudElkKX0vJHtlbmNvZGVQYXRoKHJlbGF0aXZlUGF0aCl9YCxcbiAgICBsb2NhdGlvbi5vcmlnaW4sXG4gICkuaHJlZjtcbn1cblxuLyoqIEFic29sdXRlIFVSTCBmb3IgYSBwb3J0YWwtZ2VuZXJhdGVkIGRvY3VtZW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlc3Npb25Vcmwoc2Vzc2lvbklkOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHByZWZpeCA9IG5hbWVzcGFjZVByZWZpeChnZXRCYXNlUGF0aCgpLCBTRVNTSU9OX1NFR01FTlQpO1xuICByZXR1cm4gbmV3IFVSTChcbiAgICBgJHtwcmVmaXh9JHtlbmNvZGVVUklDb21wb25lbnQoc2Vzc2lvbklkKX0vJHtlbmNvZGVQYXRoKHBhdGgpfWAsXG4gICAgbG9jYXRpb24ub3JpZ2luLFxuICApLmhyZWY7XG59XG5cbi8qKiBBYnNvbHV0ZSBVUkwgZm9yIGEgcGFnZSBzaGlwcGVkIGFsb25nc2lkZSB0aGUgcG9ydGFsLCBlLmcuIGB6YXJyY2FkZS9gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpdGVVcmwocmVsYXRpdmVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmV3IFVSTChgJHtnZXRCYXNlUGF0aCgpfSR7cmVsYXRpdmVQYXRofWAsIGxvY2F0aW9uLm9yaWdpbikuaHJlZjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHB1dFNlc3Npb25GaWxlKFxuICBzZXNzaW9uSWQ6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcsXG4gIGNvbnRlbnRUeXBlOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZWNvcmQ6IFNlc3Npb25GaWxlUmVjb3JkID0ge1xuICAgIGtleTogYCR7c2Vzc2lvbklkfS8ke3BhdGh9YCxcbiAgICBzZXNzaW9uSWQsXG4gICAgcGF0aCxcbiAgICBib2R5LFxuICAgIGNvbnRlbnRUeXBlLFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgYXdhaXQgaWRiUHV0KFNFU1NJT05fU1RPUkUsIHJlY29yZCk7XG4gIHJldHVybiBzZXNzaW9uVXJsKHNlc3Npb25JZCwgcGF0aCk7XG59XG5cbi8qKlxuICogRHJvcCBnZW5lcmF0ZWQgZG9jdW1lbnRzIGZyb20gb2xkZXIgc2Vzc2lvbnMuXG4gKlxuICogVGhleSBhcmUgdGlueSwgYnV0IHRoZXkgcmVmZXJlbmNlIG1vdW50cyB0aGF0IG1heSBiZSBnb25lLCBzbyBrZWVwaW5nIHRoZW1cbiAqIGFyb3VuZCBvbmx5IGNyZWF0ZXMgY29uZnVzaW5nIGRlYWQgbGlua3MgaW4gdGhlIGJyb3dzZXIgaGlzdG9yeS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBydW5lU2Vzc2lvbnMoa2VlcFNlc3Npb25JZD86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGwgPSBhd2FpdCBpZGJHZXRBbGw8U2Vzc2lvbkZpbGVSZWNvcmQ+KFNFU1NJT05fU1RPUkUpO1xuICBhd2FpdCBQcm9taXNlLmFsbChcbiAgICBhbGxcbiAgICAgIC5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLnNlc3Npb25JZCAhPT0ga2VlcFNlc3Npb25JZClcbiAgICAgIC5tYXAoKHJlY29yZCkgPT4gaWRiRGVsZXRlKFNFU1NJT05fU1RPUkUsIHJlY29yZC5rZXkpKSxcbiAgKTtcbn1cbiIsICIvKipcbiAqIFdoZW4gYSBwcmV2aWV3IGlzIHdvcnRoIGdlbmVyYXRpbmcsIGFuZCBob3cgYmlnIGl0IG1heSBiZS5cbiAqXG4gKiBQcmV2aWV3cyBhcmUgcmVuZGVyZWQgb24gZGVtYW5kIGZyb20gdGhlICpjb2Fyc2VzdCogbGV2ZWwgb2YgYSBkYXRhc2V0J3NcbiAqIG11bHRpc2NhbGUgcHlyYW1pZCBcdTIwMTQgdGhlIGxldmVsIHRoYXQgYWxyZWFkeSBleGlzdHMgcHJlY2lzZWx5IHNvIHRoYXQgYVxuICogd2hvbGUtaW1hZ2UgdmlldyBpcyBjaGVhcC4gTm90aGluZyBpcyBwcmVjb21wdXRlZCBhbmQgbm90aGluZyBpcyB3cml0dGVuIHRvXG4gKiBkaXNrLlxuICpcbiAqIFRoZSB3aG9sZSBsZXZlbCBoYXMgdG8gYmUgcmVhZCBhbmQgZGVjb21wcmVzc2VkIHRvIHByb2plY3QgaXQsIHNvIGVsaWdpYmlsaXR5XG4gKiBpcyBkZWNpZGVkIGZyb20gYXJyYXkgbWV0YWRhdGEgYWxvbmUsIGJlZm9yZSBhbnkgZGF0YSBpcyB0b3VjaGVkLiBBXG4gKiB3ZWxsLWZvcm1lZCBweXJhbWlkIGJvdHRvbXMgb3V0IHdlbGwgaW5zaWRlIHRoZXNlIGJvdW5kczsgYSBkYXRhc2V0IHdob3NlXG4gKiBjb2Fyc2VzdCBsZXZlbCBpcyBzdGlsbCBlbm9ybW91cyBpcyBleGFjdGx5IHRoZSBvbmUgdG8gc2tpcC5cbiAqXG4gKiBCb3RoIHRoZSBjYXRhbG9nIGJ1aWxkZXIgYW5kIHRoZSBzZXJ2aWNlIHdvcmtlciBjb25zdWx0IHRoaXMsIHNvIGEgZGF0YXNldFxuICogY2FuIG5ldmVyIGJlIGFkdmVydGlzZWQgYXMgcHJldmlld2FibGUgYW5kIHRoZW4gcmVmdXNlZC5cbiAqL1xuXG4vKiogVXBwZXIgYm91bmQgb24gdGhlIGVsZW1lbnRzIHJlYWQgdG8gYnVpbGQgb25lIHByZXZpZXcgKDEwMjQgXHUwMEQ3IDEwMjQpLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9QUkVWSUVXX0VMRU1FTlRTID0gMSA8PCAyMDtcblxuLyoqXG4gKiBVcHBlciBib3VuZCBvbiBlaXRoZXIgc3BhdGlhbCBleHRlbnQuIEVsZW1lbnQgY291bnQgYWxyZWFkeSBib3VuZHMgbWVtb3J5O1xuICogdGhpcyBhZGRpdGlvbmFsbHkgcnVsZXMgb3V0IGRlZ2VuZXJhdGUgc2hhcGVzIGxpa2UgMSBcdTAwRDcgMSwwMDAsMDAwIHRoYXQgd291bGRcbiAqIHByb2plY3QgdG8gYSBjYW52YXMgbm8gYnJvd3NlciB3aWxsIGFsbG9jYXRlLlxuICovXG5leHBvcnQgY29uc3QgTUFYX1BSRVZJRVdfRVhURU5UID0gNDA5NjtcblxuLyoqIExvbmcgZWRnZSBvZiB0aGUgZW1pdHRlZCBQTkcuIFphcnJjYWRlIHJlbmRlcnMgY2FyZHMgYXQgcm91Z2hseSAzMDAgcHguICovXG5leHBvcnQgY29uc3QgUFJFVklFV19PVVRQVVRfRURHRSA9IDUxMjtcblxuZXhwb3J0IGludGVyZmFjZSBQcmV2aWV3Q2FuZGlkYXRlIHtcbiAgLyoqIFBhdGggb2YgdGhlIGNvYXJzZXN0IGxldmVsLCByZWxhdGl2ZSB0byB0aGUgZGF0YXNldCByb290LiAqL1xuICBsZXZlbFBhdGg6IHN0cmluZztcbiAgLyoqIFNoYXBlIG9mIHRoYXQgbGV2ZWwuICovXG4gIHNoYXBlOiBudW1iZXJbXTtcbn1cblxuLyoqXG4gKiBEZWNpZGUgd2hldGhlciB0aGUgY29hcnNlc3QgbGV2ZWwgaXMgc21hbGwgZW5vdWdoIHRvIHByb2plY3QuXG4gKlxuICogYHl4YCBhcmUgdGhlIGluZGljZXMgb2YgdGhlIHR3byBzcGF0aWFsIGF4ZXMgd2l0aGluIGBzaGFwZWA7IHdoZW4gdGhlIGF4ZXNcbiAqIGFyZSB1bmtub3duIHRoZSBjYWxsZXIgcGFzc2VzIHRoZSBsYXN0IHR3byBkaW1lbnNpb25zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQcmV2aWV3YWJsZShzaGFwZTogbnVtYmVyW10sIHl4OiBbbnVtYmVyLCBudW1iZXJdKTogYm9vbGVhbiB7XG4gIGlmIChzaGFwZS5sZW5ndGggPCAyKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgaGVpZ2h0ID0gc2hhcGVbeXhbMF1dO1xuICBjb25zdCB3aWR0aCA9IHNoYXBlW3l4WzFdXTtcbiAgaWYgKCEoaGVpZ2h0ID4gMCkgfHwgISh3aWR0aCA+IDApKSByZXR1cm4gZmFsc2U7XG4gIGlmIChoZWlnaHQgPiBNQVhfUFJFVklFV19FWFRFTlQgfHwgd2lkdGggPiBNQVhfUFJFVklFV19FWFRFTlQpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBlbGVtZW50cyA9IHNoYXBlLnJlZHVjZSgodG90YWwsIGV4dGVudCkgPT4gdG90YWwgKiBleHRlbnQsIDEpO1xuICByZXR1cm4gZWxlbWVudHMgPiAwICYmIGVsZW1lbnRzIDw9IE1BWF9QUkVWSUVXX0VMRU1FTlRTO1xufVxuXG4vKipcbiAqIExvY2F0ZSB0aGUgeSBhbmQgeCBheGVzIGluIGFuIGF4aXMtbmFtZSBsaXN0LlxuICpcbiAqIE9NRS1OR0ZGIGNvbnZlbnRpb25hbGx5IG9yZGVycyBheGVzIGB0Y3p5eGAsIGJ1dCB0aGUgb3JkZXIgaXMgZGVjbGFyZWQsIG5vdFxuICogYXNzdW1lZC4gRmFsbHMgYmFjayB0byB0aGUgbGFzdCB0d28gZGltZW5zaW9ucywgd2hpY2ggaXMgdGhlIGxheW91dCBldmVyeVxuICogcHJlLTAuNCBkYXRhc2V0IHVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGF0aWFsQXhlcyhheGVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCwgcmFuazogbnVtYmVyKTogW251bWJlciwgbnVtYmVyXSB7XG4gIGlmIChheGVzICYmIGF4ZXMubGVuZ3RoID09PSByYW5rKSB7XG4gICAgY29uc3QgeSA9IGF4ZXMuZmluZEluZGV4KChheGlzKSA9PiBheGlzLnRvTG93ZXJDYXNlKCkgPT09ICd5Jyk7XG4gICAgY29uc3QgeCA9IGF4ZXMuZmluZEluZGV4KChheGlzKSA9PiBheGlzLnRvTG93ZXJDYXNlKCkgPT09ICd4Jyk7XG4gICAgaWYgKHkgIT09IC0xICYmIHggIT09IC0xKSByZXR1cm4gW3ksIHhdO1xuICB9XG4gIHJldHVybiBbcmFuayAtIDIsIHJhbmsgLSAxXTtcbn1cbiIsICIvKipcbiAqIFJlYWRpbmcgYW5kIGludGVycHJldGluZyBaYXJyIC8gT01FLU5HRkYgbWV0YWRhdGEgZnJvbSBhIGRpcmVjdG9yeSBoYW5kbGUuXG4gKlxuICogS2VwdCBzZXBhcmF0ZSBmcm9tIHRoZSB0cmF2ZXJzYWwgc28gdGhlIHJ1bGVzIGFib3V0IFwid2hhdCBjb3VudHMgYXMgYVxuICogZGF0YXNldFwiIGFyZSBpbiBvbmUgcmVhZGFibGUgcGxhY2UuIEhhbmRsZXMgYm90aCBsYXlvdXRzIGluIGN1cnJlbnQgdXNlOlxuICpcbiAqICAgWmFyciB2MiAoT01FLU5HRkYgPD0gMC40KTogYC56Z3JvdXBgIC8gYC56YXJyYXlgIC8gYC56YXR0cnNgLCB3aXRoXG4gKiAgICAgYG11bHRpc2NhbGVzYCBhdCB0aGUgdG9wIGxldmVsIG9mIGAuemF0dHJzYC5cbiAqICAgWmFyciB2MyAoT01FLU5HRkYgPj0gMC41KTogYSBzaW5nbGUgYHphcnIuanNvbmAgd2hvc2UgYG5vZGVfdHlwZWAgc2F5c1xuICogICAgIGdyb3VwIG9yIGFycmF5LCB3aXRoIGBtdWx0aXNjYWxlc2AgbmVzdGVkIHVuZGVyIGBhdHRyaWJ1dGVzLm9tZWAuXG4gKi9cblxuZXhwb3J0IHR5cGUgSnNvbk9iamVjdCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG5leHBvcnQgdHlwZSBaYXJyTm9kZSA9XG4gIHwgeyBraW5kOiAnYXJyYXknOyBmb3JtYXQ6IDIgfCAzIH1cbiAgfCB7IGtpbmQ6ICdncm91cCc7IGZvcm1hdDogMiB8IDM7IGF0dHJpYnV0ZXM6IEpzb25PYmplY3QgfVxuICAvKiogTm8gWmFyciBtZXRhZGF0YSBoZXJlOiBhbiBvcmRpbmFyeSBkaXJlY3RvcnkuICovXG4gIHwgeyBraW5kOiAnbm9uZScgfTtcblxuZXhwb3J0IGNsYXNzIE1ldGFkYXRhRXJyb3IgZXh0ZW5kcyBFcnJvciB7fVxuXG5mdW5jdGlvbiBpc09iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEpzb25PYmplY3Qge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKlxuICogUmVhZCBhbmQgcGFyc2UgYSBKU09OIGZpbGUsIHJldHVybmluZyB1bmRlZmluZWQgd2hlbiBpdCBkb2VzIG5vdCBleGlzdC5cbiAqXG4gKiBBIG1pc3NpbmcgZmlsZSBpcyB0aGUgbm9ybWFsIHdheSB0byBwcm9iZSBmb3IgYSBsYXlvdXQsIGJ1dCBhIGZpbGUgdGhhdFxuICogZXhpc3RzIGFuZCBkb2VzIG5vdCBwYXJzZSBpcyBhIHJlYWwgcHJvYmxlbSB3b3J0aCBzdXJmYWNpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkSnNvbkZpbGUoXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgbmFtZTogc3RyaW5nLFxuKTogUHJvbWlzZTxKc29uT2JqZWN0IHwgdW5kZWZpbmVkPiB7XG4gIGxldCBmaWxlOiBGaWxlO1xuICB0cnkge1xuICAgIGNvbnN0IGhhbmRsZSA9IGF3YWl0IGRpcmVjdG9yeS5nZXRGaWxlSGFuZGxlKG5hbWUpO1xuICAgIGZpbGUgPSBhd2FpdCBoYW5kbGUuZ2V0RmlsZSgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiAoZXJyb3IubmFtZSA9PT0gJ05vdEZvdW5kRXJyb3InIHx8IGVycm9yLm5hbWUgPT09ICdUeXBlTWlzbWF0Y2hFcnJvcicpKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGNvbnN0IHRleHQgPSBhd2FpdCBmaWxlLnRleHQoKTtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IG5ldyBNZXRhZGF0YUVycm9yKGAke25hbWV9IGlzIG5vdCB2YWxpZCBKU09OOiAkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuICBpZiAoIWlzT2JqZWN0KHBhcnNlZCkpIHtcbiAgICB0aHJvdyBuZXcgTWV0YWRhdGFFcnJvcihgJHtuYW1lfSBkb2VzIG5vdCBjb250YWluIGEgSlNPTiBvYmplY3RgKTtcbiAgfVxuICByZXR1cm4gcGFyc2VkO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgZGlyZWN0b3J5IGFzIGEgWmFyciBhcnJheSwgYSBaYXJyIGdyb3VwLCBvciBuZWl0aGVyLlxuICpcbiAqIFByb2JpbmcgYnkgbmFtZSBpcyBkZWxpYmVyYXRlOiBpdCBjb3N0cyBhdCBtb3N0IHRocmVlIGZhaWxlZCBsb29rdXBzIHBlclxuICogZGlyZWN0b3J5IGFuZCBuZXZlciBlbnVtZXJhdGVzIGVudHJpZXMsIHdoaWNoIG1hdHRlcnMgYmVjYXVzZSBhbiBhcnJheSdzXG4gKiBjaHVuayBkaXJlY3RvcnkgY2FuIGhvbGQgbWlsbGlvbnMgb2YgZmlsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkWmFyck5vZGUoZGlyZWN0b3J5OiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlKTogUHJvbWlzZTxaYXJyTm9kZT4ge1xuICBjb25zdCB2MyA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICd6YXJyLmpzb24nKTtcbiAgaWYgKHYzKSB7XG4gICAgLy8gYG5vZGVfdHlwZWAgaXMgcmVxdWlyZWQgaW4gWmFyciB2MzsgZGVmYXVsdCB0byBncm91cCBmb3IgdG9sZXJhbmNlLlxuICAgIGNvbnN0IG5vZGVUeXBlID0gdHlwZW9mIHYzLm5vZGVfdHlwZSA9PT0gJ3N0cmluZycgPyB2My5ub2RlX3R5cGUgOiAnZ3JvdXAnO1xuICAgIGlmIChub2RlVHlwZSA9PT0gJ2FycmF5JykgcmV0dXJuIHsga2luZDogJ2FycmF5JywgZm9ybWF0OiAzIH07XG4gICAgY29uc3QgYXR0cmlidXRlcyA9IGlzT2JqZWN0KHYzLmF0dHJpYnV0ZXMpID8gdjMuYXR0cmlidXRlcyA6IHt9O1xuICAgIHJldHVybiB7IGtpbmQ6ICdncm91cCcsIGZvcm1hdDogMywgYXR0cmlidXRlcyB9O1xuICB9XG5cbiAgaWYgKGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemFycmF5JykpIHtcbiAgICByZXR1cm4geyBraW5kOiAnYXJyYXknLCBmb3JtYXQ6IDIgfTtcbiAgfVxuXG4gIGNvbnN0IHpncm91cCA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemdyb3VwJyk7XG4gIGNvbnN0IHphdHRycyA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemF0dHJzJyk7XG4gIGlmICh6Z3JvdXAgfHwgemF0dHJzKSB7XG4gICAgcmV0dXJuIHsga2luZDogJ2dyb3VwJywgZm9ybWF0OiAyLCBhdHRyaWJ1dGVzOiB6YXR0cnMgPz8ge30gfTtcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQ6ICdub25lJyB9O1xufVxuXG4vKipcbiAqIFRoZSBhdHRyaWJ1dGUgYmFnIE9NRSBtZXRhZGF0YSBsaXZlcyBpbi5cbiAqXG4gKiBOR0ZGIDAuNSBuZXN0cyBldmVyeXRoaW5nIHVuZGVyIGFuIGBvbWVgIGtleTsgMC40IGFuZCBlYXJsaWVyIHB1dCBpdCBhdCB0aGVcbiAqIHRvcCBsZXZlbCBvZiBgLnphdHRyc2AuIFNvbWUgd3JpdGVycyBlbWl0IHRoZSAwLjQgc2hhcGUgaW5zaWRlIGEgdjNcbiAqIGB6YXJyLmpzb25gLCBzbyBib3RoIGFyZSBjaGVja2VkIHJlZ2FyZGxlc3Mgb2YgWmFyciB2ZXJzaW9uLlxuICovXG5mdW5jdGlvbiBvbWVBdHRyaWJ1dGVzKG5vZGU6IHsgYXR0cmlidXRlczogSnNvbk9iamVjdCB9KTogSnNvbk9iamVjdFtdIHtcbiAgY29uc3QgYmFnczogSnNvbk9iamVjdFtdID0gW107XG4gIGlmIChpc09iamVjdChub2RlLmF0dHJpYnV0ZXMub21lKSkgYmFncy5wdXNoKG5vZGUuYXR0cmlidXRlcy5vbWUpO1xuICBiYWdzLnB1c2gobm9kZS5hdHRyaWJ1dGVzKTtcbiAgcmV0dXJuIGJhZ3M7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTXVsdGlzY2FsZUluZm8ge1xuICAvKiogVmVyc2lvbiBkZWNsYXJlZCBieSB0aGUgbWV0YWRhdGEsIGlmIGFueS4gKi9cbiAgdmVyc2lvbj86IHN0cmluZztcbiAgLyoqIEF4aXMgbmFtZXMgaW4gb3JkZXIsIHdoZW4gdGhlIG1ldGFkYXRhIGRlY2xhcmVzIGF4ZXMgKE5HRkYgPj0gMC4zKS4gKi9cbiAgYXhlcz86IHN0cmluZ1tdO1xuICAvKiogUmVsYXRpdmUgYXJyYXkgcGF0aHMsIGNvYXJzZXN0IGxhc3QuICovXG4gIHBhdGhzOiBzdHJpbmdbXTtcbiAgbmFtZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBFeHRyYWN0IG11bHRpc2NhbGUgaW5mb3JtYXRpb24sIG9yIG51bGwgaWYgdGhpcyBncm91cCBpcyBub3QgYSBtdWx0aXNjYWxlXG4gKiBpbWFnZS4gUHJlc2VuY2Ugb2YgYG11bHRpc2NhbGVzYCBpcyB3aGF0IG1ha2VzIGEgZ3JvdXAgYSBkYXRhc2V0IHJvb3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkTXVsdGlzY2FsZShub2RlOiB7IGF0dHJpYnV0ZXM6IEpzb25PYmplY3QgfSk6IE11bHRpc2NhbGVJbmZvIHwgbnVsbCB7XG4gIGZvciAoY29uc3QgYmFnIG9mIG9tZUF0dHJpYnV0ZXMobm9kZSkpIHtcbiAgICBjb25zdCBtdWx0aXNjYWxlcyA9IGJhZy5tdWx0aXNjYWxlcztcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobXVsdGlzY2FsZXMpIHx8IG11bHRpc2NhbGVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cbiAgICBjb25zdCBmaXJzdCA9IG11bHRpc2NhbGVzWzBdO1xuICAgIGlmICghaXNPYmplY3QoZmlyc3QpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGZpcnN0LmRhdGFzZXRzKSkge1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBmaXJzdC5kYXRhc2V0cykge1xuICAgICAgICBpZiAoaXNPYmplY3QoZW50cnkpICYmIHR5cGVvZiBlbnRyeS5wYXRoID09PSAnc3RyaW5nJykgcGF0aHMucHVzaChlbnRyeS5wYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgYXhlczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZmlyc3QuYXhlcykpIHtcbiAgICAgIGNvbnN0IG5hbWVzID0gZmlyc3QuYXhlcy5tYXAoKGF4aXMpID0+XG4gICAgICAgIC8vIE5HRkYgPj0gMC40IHVzZXMgb2JqZWN0czsgMC4zIHVzZWQgYmFyZSBzdHJpbmdzLlxuICAgICAgICB0eXBlb2YgYXhpcyA9PT0gJ3N0cmluZycgPyBheGlzIDogaXNPYmplY3QoYXhpcykgJiYgdHlwZW9mIGF4aXMubmFtZSA9PT0gJ3N0cmluZycgPyBheGlzLm5hbWUgOiAnPycsXG4gICAgICApO1xuICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDApIGF4ZXMgPSBuYW1lcztcbiAgICB9XG5cbiAgICAvLyBJbiAwLjUgdGhlIHZlcnNpb24gc2l0cyBiZXNpZGUgYG11bHRpc2NhbGVzYCBpbiB0aGUgYG9tZWAgYmFnOyBpblxuICAgIC8vIGVhcmxpZXIgdmVyc2lvbnMgaXQgc2l0cyBpbnNpZGUgZWFjaCBtdWx0aXNjYWxlIGVudHJ5LlxuICAgIGNvbnN0IHZlcnNpb24gPVxuICAgICAgdHlwZW9mIGJhZy52ZXJzaW9uID09PSAnc3RyaW5nJ1xuICAgICAgICA/IGJhZy52ZXJzaW9uXG4gICAgICAgIDogdHlwZW9mIGZpcnN0LnZlcnNpb24gPT09ICdzdHJpbmcnXG4gICAgICAgICAgPyBmaXJzdC52ZXJzaW9uXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICByZXR1cm4ge1xuICAgICAgdmVyc2lvbixcbiAgICAgIGF4ZXMsXG4gICAgICBwYXRocyxcbiAgICAgIG5hbWU6IHR5cGVvZiBmaXJzdC5uYW1lID09PSAnc3RyaW5nJyA/IGZpcnN0Lm5hbWUgOiB1bmRlZmluZWQsXG4gICAgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBUcnVlIGlmIHRoZSBncm91cCBhZHZlcnRpc2VzIHRodW1ibmFpbHMgdmlhIHRoZSB6YXJyIHRodW1ibmFpbHMgY29udmVudGlvbi5cbiAqXG4gKiBaYXJyY2FkZSByZWFkcyB0aGVzZSBpdHNlbGYgYW5kIHBpY2tzIHRoZSBiZXN0LXNpemVkIGVudHJ5LCBzbyB3aGVuIHRoZXkgYXJlXG4gKiBwcmVzZW50IHRoZSBwb3J0YWwgc3RlcHMgYXNpZGUgcmF0aGVyIHRoYW4gZ2VuZXJhdGluZyBhIHByZXZpZXcuIE1hdGNoZXNcbiAqIHVwc3RyZWFtIGluIGNvbnN1bHRpbmcgb25seSBgemFyci5qc29uYCwgaS5lLiBaYXJyIHYzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzVGh1bWJuYWlsc0NvbnZlbnRpb24obm9kZTogeyBmb3JtYXQ6IDIgfCAzOyBhdHRyaWJ1dGVzOiBKc29uT2JqZWN0IH0pOiBib29sZWFuIHtcbiAgaWYgKG5vZGUuZm9ybWF0ICE9PSAzKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHRodW1ibmFpbHMgPSBub2RlLmF0dHJpYnV0ZXMudGh1bWJuYWlscztcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGh1bWJuYWlscykgJiYgdGh1bWJuYWlscy5sZW5ndGggPiAwO1xufVxuXG4vKiogVHJ1ZSBpZiB0aGUgZ3JvdXAgaXMgYW4gSENTIHBsYXRlIHJvb3QuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQbGF0ZShub2RlOiB7IGF0dHJpYnV0ZXM6IEpzb25PYmplY3QgfSk6IGJvb2xlYW4ge1xuICByZXR1cm4gb21lQXR0cmlidXRlcyhub2RlKS5zb21lKChiYWcpID0+IGlzT2JqZWN0KGJhZy5wbGF0ZSkpO1xufVxuXG4vKiogVHJ1ZSBpZiB0aGUgZ3JvdXAgaXMgYSBgYmlvZm9ybWF0czJyYXcubGF5b3V0YCBjb250YWluZXIgb2YgaW1hZ2Ugc2VyaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQmlvZm9ybWF0czJSYXdMYXlvdXQobm9kZTogeyBhdHRyaWJ1dGVzOiBKc29uT2JqZWN0IH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG9tZUF0dHJpYnV0ZXMobm9kZSkuc29tZSgoYmFnKSA9PiBiYWdbJ2Jpb2Zvcm1hdHMycmF3LmxheW91dCddICE9PSB1bmRlZmluZWQpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFycmF5SW5mbyB7XG4gIHNoYXBlPzogbnVtYmVyW107XG4gIGR0eXBlPzogc3RyaW5nO1xufVxuXG4vKiogUmVhZCBzaGFwZSBhbmQgZHR5cGUgZnJvbSBhbiBhcnJheSdzIG93biBtZXRhZGF0YSwgZm9yIGRpc3BsYXkgcHVycG9zZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZEFycmF5SW5mbyhyYXc6IEpzb25PYmplY3QpOiBBcnJheUluZm8ge1xuICBjb25zdCBzaGFwZSA9IEFycmF5LmlzQXJyYXkocmF3LnNoYXBlKSAmJiByYXcuc2hhcGUuZXZlcnkoKG4pID0+IHR5cGVvZiBuID09PSAnbnVtYmVyJylcbiAgICA/IChyYXcuc2hhcGUgYXMgbnVtYmVyW10pXG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgLy8gdjMgY2FsbHMgaXQgYGRhdGFfdHlwZWAsIHYyIGBkdHlwZWAgKHdpdGggYSBieXRlLW9yZGVyIHByZWZpeCBsaWtlIGA8dTJgKS5cbiAgY29uc3QgZHR5cGUgPVxuICAgIHR5cGVvZiByYXcuZGF0YV90eXBlID09PSAnc3RyaW5nJ1xuICAgICAgPyByYXcuZGF0YV90eXBlXG4gICAgICA6IHR5cGVvZiByYXcuZHR5cGUgPT09ICdzdHJpbmcnXG4gICAgICAgID8gcmF3LmR0eXBlXG4gICAgICAgIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7IHNoYXBlLCBkdHlwZSB9O1xufVxuIiwgIi8qKlxuICogVHlwZXMgZm9yIHRoZSBPTUUtWmFyciBkaXNjb3ZlcnkgbGF5ZXIuXG4gKi9cblxuLyoqIEEgbXVsdGlzY2FsZSBPTUUtWmFyciBpbWFnZSBmb3VuZCBpbnNpZGUgYSBtb3VudGVkIGRpcmVjdG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJlZERhdGFzZXQge1xuICAvKiogU3RhYmxlIHdpdGhpbiBhIHNlc3Npb246IGA8bW91bnQtaWQ+OjxyZWxhdGl2ZS1wYXRoPmAuICovXG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBEaXNwbGF5IG5hbWUsIGZyb20gdGhlIGRpcmVjdG9yeSBuYW1lIHdpdGggYC5vbWUuemFycmAvYC56YXJyYCBzdHJpcHBlZC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogUGF0aCByZWxhdGl2ZSB0byB0aGUgbW91bnQgcm9vdDsgZW1wdHkgd2hlbiB0aGUgbW91bnQgcm9vdCBpcyBpdHNlbGYgYSBkYXRhc2V0LiAqL1xuICByZWxhdGl2ZVBhdGg6IHN0cmluZztcbiAgLyoqIFNhbWUtb3JpZ2luIFVSTCBzZXJ2ZWQgYnkgdGhlIHdvcmtlciwgYWx3YXlzIHdpdGggYSB0cmFpbGluZyBzbGFzaC4gKi9cbiAgdmlydHVhbFVybDogc3RyaW5nO1xuICAvKiogT01FLU5HRkYgdmVyc2lvbiBzdHJpbmcsIGUuZy4gYDAuNGAgb3IgYDAuNWAsIHdoZW4gdGhlIG1ldGFkYXRhIGRlY2xhcmVzIG9uZS4gKi9cbiAgb21lWmFyclZlcnNpb24/OiBzdHJpbmc7XG5cbiAgLyogLS0tIGNvbnRleHQgYW5kIGJlc3QtZWZmb3J0IG1ldGFkYXRhLCB1c2VkIGJ5IHRoZSBnYWxsZXJ5IC0tLSAqL1xuICBtb3VudElkOiBzdHJpbmc7XG4gIG1vdW50TmFtZTogc3RyaW5nO1xuICAvKiogWmFyciBzcGVjaWZpY2F0aW9uIHZlcnNpb24gb2YgdGhlIGdyb3VwOiAyIG9yIDMuICovXG4gIHphcnJGb3JtYXQ6IDIgfCAzO1xuICAvKiogQXhpcyBuYW1lcyBvZiB0aGUgbXVsdGlzY2FsZSwgZS5nLiBgWyd0JywnYycsJ3onLCd5JywneCddYC4gKi9cbiAgYXhlcz86IHN0cmluZ1tdO1xuICAvKiogU2hhcGUgb2YgdGhlIGhpZ2hlc3QtcmVzb2x1dGlvbiBhcnJheS4gKi9cbiAgc2hhcGU/OiBudW1iZXJbXTtcbiAgLyoqIERhdGEgdHlwZSBvZiB0aGUgaGlnaGVzdC1yZXNvbHV0aW9uIGFycmF5LCBlLmcuIGB1aW50MTZgLiAqL1xuICBkdHlwZT86IHN0cmluZztcbiAgLyoqIE51bWJlciBvZiByZXNvbHV0aW9uIGxldmVscy4gKi9cbiAgc2NhbGVDb3VudD86IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBkYXRhc2V0IGFkdmVydGlzZXMgaXRzIG93biB0aHVtYm5haWxzICh6YXJyIHRodW1ibmFpbHMgY29udmVudGlvbikuXG4gICAqIFphcnJjYWRlIHJlYWRzIHRob3NlIGRpcmVjdGx5LCBzbyBubyBwcmV2aWV3IG5lZWRzIGdlbmVyYXRpbmcuXG4gICAqL1xuICBoYXNDb252ZW50aW9uVGh1bWJuYWlsPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBjb2Fyc2VzdCBweXJhbWlkIGxldmVsIGlzIHNtYWxsIGVub3VnaCB0byBwcm9qZWN0IGludG8gYSBwcmV2aWV3LlxuICAgKiBGYWxzZSB3aGVuIHRoZXJlIGlzIG5vIHB5cmFtaWQgbWV0YWRhdGEsIG9yIHRoZSBzbWFsbGVzdCBsZXZlbCBpcyBzdGlsbFxuICAgKiB0b28gbGFyZ2UgdG8gcmVhZCB3aG9sZSBcdTIwMTQgc2VlIGBzcmMvcHJldmlldy9wb2xpY3kudHNgLlxuICAgKi9cbiAgcHJldmlld2FibGU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgdHlwZSBEaXNjb3ZlcnlOb3RlS2luZCA9XG4gIC8qKiBTb21ldGhpbmcgcmVjb2duaXNhYmxlIHRoYXQgdGhpcyBwb3J0YWwgY2Fubm90IG9wZW4uICovXG4gIHwgJ3Vuc3VwcG9ydGVkJ1xuICAvKiogU29tZXRoaW5nIGRlbGliZXJhdGVseSBub3QgdHJlYXRlZCBhcyBhIGRhdGFzZXQuICovXG4gIHwgJ3NraXBwZWQnXG4gIC8qKiBNZXRhZGF0YSB0aGF0IGV4aXN0cyBidXQgY291bGQgbm90IGJlIHJlYWQuICovXG4gIHwgJ2Vycm9yJ1xuICAvKiogQSB0cmF2ZXJzYWwgbGltaXQgc3RvcHBlZCB0aGUgc2VhcmNoIGVhcmx5LiAqL1xuICB8ICdsaW1pdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJ5Tm90ZSB7XG4gIGtpbmQ6IERpc2NvdmVyeU5vdGVLaW5kO1xuICAvKiogSHVtYW4tcmVhZGFibGUgbG9jYXRpb24sIGUuZy4gYG15LWZvbGRlci9wbGF0ZS5vbWUuemFycmAuICovXG4gIHBhdGg6IHN0cmluZztcbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvdmVyeVJlc3VsdCB7XG4gIGRhdGFzZXRzOiBEaXNjb3ZlcmVkRGF0YXNldFtdO1xuICBub3RlczogRGlzY292ZXJ5Tm90ZVtdO1xuICBkaXJlY3Rvcmllc1NjYW5uZWQ6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBCb3VuZHMgb24gdGhlIHdhbGsuIEEgZHJvcHBlZCBmb2xkZXIgY2FuIGJlIGFueXRoaW5nIFx1MjAxNCBhIGhvbWUgZGlyZWN0b3J5LCBhXG4gKiBwbGF0ZSB3aXRoIHRlbnMgb2YgdGhvdXNhbmRzIG9mIHdlbGxzIFx1MjAxNCBzbyBldmVyeSBkaW1lbnNpb24gb2YgdGhlIHNlYXJjaCBpc1xuICogY2FwcGVkIGFuZCB0aGUgdXNlciBpcyB0b2xkIHdoZW4gYSBjYXAgd2FzIGhpdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBEaXNjb3ZlcnlMaW1pdHMge1xuICBtYXhEZXB0aDogbnVtYmVyO1xuICBtYXhEYXRhc2V0czogbnVtYmVyO1xuICBtYXhEaXJlY3RvcmllczogbnVtYmVyO1xuICBtYXhFbnRyaWVzUGVyRGlyZWN0b3J5OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX0xJTUlUUzogRGlzY292ZXJ5TGltaXRzID0ge1xuICBtYXhEZXB0aDogMTAsXG4gIG1heERhdGFzZXRzOiAxMDAwLFxuICBtYXhEaXJlY3RvcmllczogMjAwMDAsXG4gIG1heEVudHJpZXNQZXJEaXJlY3Rvcnk6IDUwMDAsXG59O1xuXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvdmVyeVByb2dyZXNzIHtcbiAgZGlyZWN0b3JpZXNTY2FubmVkOiBudW1iZXI7XG4gIGRhdGFzZXRzRm91bmQ6IG51bWJlcjtcbiAgY3VycmVudFBhdGg6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEaXNjb3ZlcnlPcHRpb25zIHtcbiAgbGltaXRzPzogUGFydGlhbDxEaXNjb3ZlcnlMaW1pdHM+O1xuICAvKipcbiAgICogQnVpbGQgdGhlIHZpcnR1YWwgVVJMIGZvciBhIHBhdGggaW5zaWRlIGEgbW91bnQuIERlZmF1bHRzIHRvIHRoZSBzZXJ2aWNlXG4gICAqIHdvcmtlcidzIGBfbG9jYWwvYCBuYW1lc3BhY2U7IGluamVjdGFibGUgc28gZGlzY292ZXJ5IGRvZXMgbm90IGRlcGVuZCBvblxuICAgKiB0aGUgdmlydHVhbC1maWxlc3lzdGVtIGxheWVyIChhbmQgc28gaXQgY2FuIGJlIHRlc3RlZCB3aXRob3V0IGEgYnJvd3NlcikuXG4gICAqL1xuICB1cmxCdWlsZGVyPzogKG1vdW50SWQ6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcpID0+IHN0cmluZztcbiAgb25Qcm9ncmVzcz86IChwcm9ncmVzczogRGlzY292ZXJ5UHJvZ3Jlc3MpID0+IHZvaWQ7XG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xufVxuIiwgIi8qKlxuICogUmVjdXJzaXZlIE9NRS1aYXJyIGRpc2NvdmVyeS5cbiAqXG4gKiBHaXZlbiBtb3VudGVkIGRpcmVjdG9yaWVzLCBmaW5kIGV2ZXJ5IG11bHRpc2NhbGUgT01FLVphcnIgaW1hZ2UgYmVsb3cgdGhlbVxuICogYW5kIHJldHVybiBhIG5vcm1hbGl6ZWQgbGlzdCB3aXRoIHNhbWUtb3JpZ2luIFVSTHMuIFRoZSB0cmF2ZXJzYWwgaXNcbiAqIGZvcm1hdC1kcml2ZW4gcmF0aGVyIHRoYW4gbmFtZS1kcml2ZW46IGEgYC5vbWUuemFycmAgc3VmZml4IGlzIGEgY29udmVudGlvbixcbiAqIG5vdCBhIGd1YXJhbnRlZSwgYW5kIHBsZW50eSBvZiB2YWxpZCBkYXRhc2V0cyBkbyBub3QgdXNlIGl0LlxuICpcbiAqIFR3byBydWxlcyBrZWVwIHRoZSB3YWxrIGNvcnJlY3QgYW5kIGNoZWFwOlxuICpcbiAqICAxLiBBIGdyb3VwIGNhcnJ5aW5nIGBtdWx0aXNjYWxlc2AgSVMgdGhlIGRhdGFzZXQuIFRoZSB3YWxrIHN0b3BzIHRoZXJlLCBzb1xuICogICAgIHRoZSByZXNvbHV0aW9uIGxldmVscyBiZW5lYXRoIGl0IGFyZSBuZXZlciBtaXN0YWtlbiBmb3IgZGF0YXNldHMgb2ZcbiAqICAgICB0aGVpciBvd24uXG4gKiAgMi4gQSBaYXJyIGFycmF5IGlzIG5ldmVyIGRlc2NlbmRlZCBpbnRvLiBJdHMgY2hpbGRyZW4gYXJlIGNodW5rIGZpbGVzIGFuZFxuICogICAgIGNodW5rIGRpcmVjdG9yaWVzLCBhbmQgZW51bWVyYXRpbmcgdGhlbSBjb3VsZCBtZWFuIG1pbGxpb25zIG9mIGVudHJpZXMuXG4gKi9cbmltcG9ydCB0eXBlIHsgTW91bnQgfSBmcm9tICcuLi9tb3VudHMvcmVnaXN0cnknO1xuaW1wb3J0IHsgbG9jYWxVcmwgfSBmcm9tICcuLi92ZnMvY2xpZW50JztcbmltcG9ydCB7IGlzUHJldmlld2FibGUsIHNwYXRpYWxBeGVzIH0gZnJvbSAnLi4vcHJldmlldy9wb2xpY3knO1xuaW1wb3J0IHtcbiAgaGFzVGh1bWJuYWlsc0NvbnZlbnRpb24sXG4gIGlzQmlvZm9ybWF0czJSYXdMYXlvdXQsXG4gIGlzUGxhdGUsXG4gIHJlYWRBcnJheUluZm8sXG4gIHJlYWRKc29uRmlsZSxcbiAgcmVhZE11bHRpc2NhbGUsXG4gIHJlYWRaYXJyTm9kZSxcbiAgdHlwZSBNdWx0aXNjYWxlSW5mbyxcbiAgdHlwZSBaYXJyTm9kZSxcbn0gZnJvbSAnLi96YXJyLW1ldGFkYXRhJztcbmltcG9ydCB7XG4gIERFRkFVTFRfTElNSVRTLFxuICB0eXBlIERpc2NvdmVyZWREYXRhc2V0LFxuICB0eXBlIERpc2NvdmVyeUxpbWl0cyxcbiAgdHlwZSBEaXNjb3ZlcnlOb3RlLFxuICB0eXBlIERpc2NvdmVyeU9wdGlvbnMsXG4gIHR5cGUgRGlzY292ZXJ5UmVzdWx0LFxufSBmcm9tICcuL3R5cGVzJztcblxuLyoqIEVudHJpZXMgdGhhdCBhcmUgbmV2ZXIgcGFydCBvZiBhIFphcnIgaGllcmFyY2h5LiAqL1xuY29uc3QgSUdOT1JFRF9OQU1FUyA9IG5ldyBTZXQoWydfX01BQ09TWCcsICcuRFNfU3RvcmUnLCAnVGh1bWJzLmRiJywgJy5naXQnXSk7XG5cbmZ1bmN0aW9uIGlzSWdub3JlZChuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gRG90ZmlsZXMgYXJlIHNraXBwZWQgYXMgZGlyZWN0b3JpZXMsIGJ1dCBaYXJyIHYyJ3Mgb3duIGAuemdyb3VwYC9gLnphdHRyc2BcbiAgLy8gYXJlIGZpbGVzIGFuZCBhcmUgcmVhZCBieSBuYW1lLCBzbyBub3RoaW5nIG5lZWRlZCBpcyBsb3N0IGhlcmUuXG4gIHJldHVybiBJR05PUkVEX05BTUVTLmhhcyhuYW1lKSB8fCBuYW1lLnN0YXJ0c1dpdGgoJy4nKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwuZW5kc1dpdGgoJy8nKSA/IHVybCA6IGAke3VybH0vYDtcbn1cblxuZnVuY3Rpb24gZGlzcGxheU5hbWUocmVsYXRpdmVQYXRoOiBzdHJpbmcsIG1vdW50OiBNb3VudCwgbXVsdGlzY2FsZTogTXVsdGlzY2FsZUluZm8pOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gcmVsYXRpdmVQYXRoID09PSAnJyA/IG1vdW50Lm5hbWUgOiByZWxhdGl2ZVBhdGguc2xpY2UocmVsYXRpdmVQYXRoLmxhc3RJbmRleE9mKCcvJykgKyAxKTtcbiAgY29uc3Qgc3RyaXBwZWQgPSBiYXNlLnJlcGxhY2UoL1xcLm9tZVxcLnphcnIkL2ksICcnKS5yZXBsYWNlKC9cXC56YXJyJC9pLCAnJyk7XG4gIHJldHVybiBzdHJpcHBlZCB8fCBtdWx0aXNjYWxlLm5hbWUgfHwgYmFzZSB8fCAnVW50aXRsZWQnO1xufVxuXG4vKiogTG9jYXRpb24gc2hvd24gdG8gdGhlIHVzZXIgaW4gbm90ZXMgYW5kIGluIHRoZSBnYWxsZXJ5LiAqL1xuZnVuY3Rpb24gZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoOiBzdHJpbmcsIG1vdW50OiBNb3VudCk6IHN0cmluZyB7XG4gIHJldHVybiByZWxhdGl2ZVBhdGggPT09ICcnID8gbW91bnQubmFtZSA6IGAke21vdW50Lm5hbWV9LyR7cmVsYXRpdmVQYXRofWA7XG59XG5cbmludGVyZmFjZSBXYWxrQ29udGV4dCB7XG4gIG1vdW50OiBNb3VudDtcbiAgYnVpbGRVcmw6IChtb3VudElkOiBzdHJpbmcsIHJlbGF0aXZlUGF0aDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIGxpbWl0czogRGlzY292ZXJ5TGltaXRzO1xuICBkYXRhc2V0czogRGlzY292ZXJlZERhdGFzZXRbXTtcbiAgbm90ZXM6IERpc2NvdmVyeU5vdGVbXTtcbiAgZGlyZWN0b3JpZXNTY2FubmVkOiBudW1iZXI7XG4gIGxpbWl0UmVwb3J0ZWQ6IFNldDxzdHJpbmc+O1xuICBvcHRpb25zOiBEaXNjb3ZlcnlPcHRpb25zO1xufVxuXG5mdW5jdGlvbiBub3RlKGNvbnRleHQ6IFdhbGtDb250ZXh0LCBub3RlOiBEaXNjb3ZlcnlOb3RlKTogdm9pZCB7XG4gIGNvbnRleHQubm90ZXMucHVzaChub3RlKTtcbn1cblxuLyoqIFJlcG9ydCBhIGxpbWl0IGF0IG1vc3Qgb25jZSBwZXIga2luZCwgc28gbm90ZXMgc3RheSByZWFkYWJsZS4gKi9cbmZ1bmN0aW9uIHJlcG9ydExpbWl0KGNvbnRleHQ6IFdhbGtDb250ZXh0LCBrZXk6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChjb250ZXh0LmxpbWl0UmVwb3J0ZWQuaGFzKGtleSkpIHJldHVybjtcbiAgY29udGV4dC5saW1pdFJlcG9ydGVkLmFkZChrZXkpO1xuICBub3RlKGNvbnRleHQsIHsga2luZDogJ2xpbWl0JywgcGF0aDogY29udGV4dC5tb3VudC5uYW1lLCBtZXNzYWdlIH0pO1xufVxuXG4vKipcbiAqIFJlYWQgb25lIHB5cmFtaWQgbGV2ZWwncyBhcnJheSBtZXRhZGF0YS5cbiAqXG4gKiBCZXN0LWVmZm9ydDogdGhpcyBpcyBkaXNwbGF5IG1ldGFkYXRhIGZvciB0aGUgZ2FsbGVyeSwgc28gYW55IGZhaWx1cmUgaXNcbiAqIHN3YWxsb3dlZCByYXRoZXIgdGhhbiB0dXJuZWQgaW50byBhIG5vdGUgdGhlIHVzZXIgY2Fubm90IGFjdCBvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZExldmVsSW5mbyhcbiAgZGlyZWN0b3J5OiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlLFxuICBsZXZlbFBhdGg6IHN0cmluZyxcbiAgZm9ybWF0OiAyIHwgMyxcbik6IFByb21pc2U8eyBzaGFwZT86IG51bWJlcltdOyBkdHlwZT86IHN0cmluZyB9PiB7XG4gIHRyeSB7XG4gICAgbGV0IGN1cnJlbnQgPSBkaXJlY3Rvcnk7XG4gICAgZm9yIChjb25zdCBzZWdtZW50IG9mIGxldmVsUGF0aC5zcGxpdCgnLycpLmZpbHRlcihCb29sZWFuKSkge1xuICAgICAgY3VycmVudCA9IGF3YWl0IGN1cnJlbnQuZ2V0RGlyZWN0b3J5SGFuZGxlKHNlZ21lbnQpO1xuICAgIH1cbiAgICBjb25zdCByYXcgPVxuICAgICAgZm9ybWF0ID09PSAzXG4gICAgICAgID8gYXdhaXQgcmVhZEpzb25GaWxlKGN1cnJlbnQsICd6YXJyLmpzb24nKVxuICAgICAgICA6IGF3YWl0IHJlYWRKc29uRmlsZShjdXJyZW50LCAnLnphcnJheScpO1xuICAgIHJldHVybiByYXcgPyByZWFkQXJyYXlJbmZvKHJhdykgOiB7fTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG59XG5cbi8qKlxuICogRGVjaWRlIHdoZXRoZXIgYSBwcmV2aWV3IGNhbiBiZSBwcm9qZWN0ZWQgZnJvbSB0aGUgY29hcnNlc3QgbGV2ZWwuXG4gKlxuICogUmVhZHMgb25seSB0aGF0IGxldmVsJ3MgbWV0YWRhdGEgXHUyMDE0IG5ldmVyIGl0cyBkYXRhIFx1MjAxNCBzbyBhbiBpbmVsaWdpYmxlIGRhdGFzZXRcbiAqIGNvc3RzIG9uZSBzbWFsbCBKU09OIHJlYWQgYW5kIGlzIHNpbXBseSBsZWZ0IHdpdGhvdXQgYSBwcmV2aWV3LlxuICovXG5hc3luYyBmdW5jdGlvbiBjaGVja1ByZXZpZXdhYmxlKFxuICBkaXJlY3Rvcnk6IEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGUsXG4gIG11bHRpc2NhbGU6IE11bHRpc2NhbGVJbmZvLFxuICBmb3JtYXQ6IDIgfCAzLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNvYXJzZXN0ID0gbXVsdGlzY2FsZS5wYXRoc1ttdWx0aXNjYWxlLnBhdGhzLmxlbmd0aCAtIDFdO1xuICBpZiAoIWNvYXJzZXN0KSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgeyBzaGFwZSB9ID0gYXdhaXQgcmVhZExldmVsSW5mbyhkaXJlY3RvcnksIGNvYXJzZXN0LCBmb3JtYXQpO1xuICBpZiAoIXNoYXBlIHx8IHNoYXBlLmxlbmd0aCA8IDIpIHJldHVybiBmYWxzZTtcblxuICByZXR1cm4gaXNQcmV2aWV3YWJsZShzaGFwZSwgc3BhdGlhbEF4ZXMobXVsdGlzY2FsZS5heGVzLCBzaGFwZS5sZW5ndGgpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVjb3JkRGF0YXNldChcbiAgY29udGV4dDogV2Fsa0NvbnRleHQsXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4gIG5vZGU6IEV4dHJhY3Q8WmFyck5vZGUsIHsga2luZDogJ2dyb3VwJyB9PixcbiAgbXVsdGlzY2FsZTogTXVsdGlzY2FsZUluZm8sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBtb3VudCB9ID0gY29udGV4dDtcbiAgY29uc3QgZmluZXN0ID0gbXVsdGlzY2FsZS5wYXRoc1swXTtcbiAgY29uc3QgeyBzaGFwZSwgZHR5cGUgfSA9IGZpbmVzdFxuICAgID8gYXdhaXQgcmVhZExldmVsSW5mbyhkaXJlY3RvcnksIGZpbmVzdCwgbm9kZS5mb3JtYXQpXG4gICAgOiB7fTtcblxuICBjb25zdCBoYXNDb252ZW50aW9uVGh1bWJuYWlsID0gaGFzVGh1bWJuYWlsc0NvbnZlbnRpb24obm9kZSk7XG4gIC8vIEEgZGF0YXNldCB0aGF0IHNoaXBzIGl0cyBvd24gdGh1bWJuYWlscyBuZWVkcyBubyBwcmV2aWV3IGZyb20gdXMsIHNvIHNraXBcbiAgLy8gdGhlIGV4dHJhIG1ldGFkYXRhIHJlYWQgZW50aXJlbHkuXG4gIGNvbnN0IHByZXZpZXdhYmxlID0gaGFzQ29udmVudGlvblRodW1ibmFpbFxuICAgID8gZmFsc2VcbiAgICA6IGF3YWl0IGNoZWNrUHJldmlld2FibGUoZGlyZWN0b3J5LCBtdWx0aXNjYWxlLCBub2RlLmZvcm1hdCk7XG5cbiAgY29udGV4dC5kYXRhc2V0cy5wdXNoKHtcbiAgICBpZDogYCR7bW91bnQuaWR9OiR7cmVsYXRpdmVQYXRoIHx8ICcuJ31gLFxuICAgIG5hbWU6IGRpc3BsYXlOYW1lKHJlbGF0aXZlUGF0aCwgbW91bnQsIG11bHRpc2NhbGUpLFxuICAgIHJlbGF0aXZlUGF0aCxcbiAgICB2aXJ0dWFsVXJsOiBlbnN1cmVUcmFpbGluZ1NsYXNoKGNvbnRleHQuYnVpbGRVcmwobW91bnQuaWQsIHJlbGF0aXZlUGF0aCkpLFxuICAgIG9tZVphcnJWZXJzaW9uOiBtdWx0aXNjYWxlLnZlcnNpb24sXG4gICAgbW91bnRJZDogbW91bnQuaWQsXG4gICAgbW91bnROYW1lOiBtb3VudC5uYW1lLFxuICAgIHphcnJGb3JtYXQ6IG5vZGUuZm9ybWF0LFxuICAgIGF4ZXM6IG11bHRpc2NhbGUuYXhlcyxcbiAgICBzaGFwZSxcbiAgICBkdHlwZSxcbiAgICBzY2FsZUNvdW50OiBtdWx0aXNjYWxlLnBhdGhzLmxlbmd0aCB8fCB1bmRlZmluZWQsXG4gICAgaGFzQ29udmVudGlvblRodW1ibmFpbCxcbiAgICBwcmV2aWV3YWJsZSxcbiAgfSk7XG59XG5cbi8qKiBMaXN0IGNoaWxkIGRpcmVjdG9yaWVzLCBob25vdXJpbmcgdGhlIHBlci1kaXJlY3RvcnkgY2FwLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hpbGREaXJlY3RvcmllcyhcbiAgY29udGV4dDogV2Fsa0NvbnRleHQsXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVbXT4ge1xuICBjb25zdCBjaGlsZHJlbjogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZVtdID0gW107XG4gIGxldCBzZWVuID0gMDtcblxuICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIGRpcmVjdG9yeS52YWx1ZXMoKSkge1xuICAgIGlmICgrK3NlZW4gPiBjb250ZXh0LmxpbWl0cy5tYXhFbnRyaWVzUGVyRGlyZWN0b3J5KSB7XG4gICAgICBub3RlKGNvbnRleHQsIHtcbiAgICAgICAga2luZDogJ2xpbWl0JyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogYFN0b3BwZWQgYWZ0ZXIgJHtjb250ZXh0LmxpbWl0cy5tYXhFbnRyaWVzUGVyRGlyZWN0b3J5fSBlbnRyaWVzIGluIHRoaXMgZm9sZGVyLmAsXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAoZW50cnkua2luZCAhPT0gJ2RpcmVjdG9yeScgfHwgaXNJZ25vcmVkKGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICBjaGlsZHJlbi5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIC8vIFN0YWJsZSwgaHVtYW4gb3JkZXI6IGAwLCAxLCAyLCAxMGAgcmF0aGVyIHRoYW4gYDAsIDEsIDEwLCAyYC5cbiAgY2hpbGRyZW4uc29ydCgoYSwgYikgPT4gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lLCB1bmRlZmluZWQsIHsgbnVtZXJpYzogdHJ1ZSB9KSk7XG4gIHJldHVybiBjaGlsZHJlbjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FsayhcbiAgY29udGV4dDogV2Fsa0NvbnRleHQsXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4gIGRlcHRoOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29udGV4dC5vcHRpb25zLnNpZ25hbD8udGhyb3dJZkFib3J0ZWQoKTtcblxuICBpZiAoY29udGV4dC5kYXRhc2V0cy5sZW5ndGggPj0gY29udGV4dC5saW1pdHMubWF4RGF0YXNldHMpIHtcbiAgICByZXBvcnRMaW1pdChcbiAgICAgIGNvbnRleHQsXG4gICAgICAnZGF0YXNldHMnLFxuICAgICAgYFN0b3BwZWQgYWZ0ZXIgJHtjb250ZXh0LmxpbWl0cy5tYXhEYXRhc2V0c30gZGF0YXNldHM7IHRoZSBmb2xkZXIgY29udGFpbnMgbW9yZS5gLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChjb250ZXh0LmRpcmVjdG9yaWVzU2Nhbm5lZCA+PSBjb250ZXh0LmxpbWl0cy5tYXhEaXJlY3Rvcmllcykge1xuICAgIHJlcG9ydExpbWl0KFxuICAgICAgY29udGV4dCxcbiAgICAgICdkaXJlY3RvcmllcycsXG4gICAgICBgU3RvcHBlZCBhZnRlciBzY2FubmluZyAke2NvbnRleHQubGltaXRzLm1heERpcmVjdG9yaWVzfSBmb2xkZXJzLmAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb250ZXh0LmRpcmVjdG9yaWVzU2Nhbm5lZCArPSAxO1xuICBjb250ZXh0Lm9wdGlvbnMub25Qcm9ncmVzcz8uKHtcbiAgICBkaXJlY3Rvcmllc1NjYW5uZWQ6IGNvbnRleHQuZGlyZWN0b3JpZXNTY2FubmVkLFxuICAgIGRhdGFzZXRzRm91bmQ6IGNvbnRleHQuZGF0YXNldHMubGVuZ3RoLFxuICAgIGN1cnJlbnRQYXRoOiBkaXNwbGF5UGF0aChyZWxhdGl2ZVBhdGgsIGNvbnRleHQubW91bnQpLFxuICB9KTtcblxuICBsZXQgbm9kZTogWmFyck5vZGU7XG4gIHRyeSB7XG4gICAgbm9kZSA9IGF3YWl0IHJlYWRaYXJyTm9kZShkaXJlY3RvcnkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG5vdGUoY29udGV4dCwge1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IGRpc3BsYXlQYXRoKHJlbGF0aXZlUGF0aCwgY29udGV4dC5tb3VudCksXG4gICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG5vZGUua2luZCA9PT0gJ2FycmF5Jykge1xuICAgIC8vIFJ1bGUgMi4gQXQgdGhlIHRvcCBsZXZlbCB0aGlzIGlzIHdvcnRoIHJlcG9ydGluZywgYmVjYXVzZSB0aGUgdXNlclxuICAgIC8vIHBvaW50ZWQgYXQgaXQgZGVsaWJlcmF0ZWx5OyBkZWVwZXIgZG93biBpdCBpcyBqdXN0IGEgcmVzb2x1dGlvbiBsZXZlbC5cbiAgICBpZiAoZGVwdGggPT09IDApIHtcbiAgICAgIG5vdGUoY29udGV4dCwge1xuICAgICAgICBraW5kOiAndW5zdXBwb3J0ZWQnLFxuICAgICAgICBwYXRoOiBkaXNwbGF5UGF0aChyZWxhdGl2ZVBhdGgsIGNvbnRleHQubW91bnQpLFxuICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICdUaGlzIGlzIGEgYmFyZSBaYXJyIGFycmF5LCBub3QgYW4gT01FLVphcnIgbXVsdGlzY2FsZSBpbWFnZS4gRHJvcCB0aGUgZ3JvdXAgdGhhdCBjb250YWlucyBpdC4nLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChub2RlLmtpbmQgPT09ICdncm91cCcpIHtcbiAgICBjb25zdCBtdWx0aXNjYWxlID0gcmVhZE11bHRpc2NhbGUobm9kZSk7XG4gICAgaWYgKG11bHRpc2NhbGUpIHtcbiAgICAgIC8vIFJ1bGUgMS5cbiAgICAgIGF3YWl0IHJlY29yZERhdGFzZXQoY29udGV4dCwgZGlyZWN0b3J5LCByZWxhdGl2ZVBhdGgsIG5vZGUsIG11bHRpc2NhbGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChpc1BsYXRlKG5vZGUpKSB7XG4gICAgICAvLyBBIHBsYXRlIGlzIG5vdCBpdHNlbGYgb3BlbmFibGUgYXMgYW4gaW1hZ2UsIGJ1dCB0aGUgZmllbGQtb2Ytdmlld1xuICAgICAgLy8gaW1hZ2VzIGluc2lkZSBpdCBhcmUsIHNvIGtlZXAgd2Fsa2luZyBhbmQgc2F5IHdoYXQgd2UgZGlkLlxuICAgICAgbm90ZShjb250ZXh0LCB7XG4gICAgICAgIGtpbmQ6ICdza2lwcGVkJyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogJ0hDUyBwbGF0ZTogbGlzdGluZyB0aGUgaW1hZ2VzIGluc2lkZSBpdCBpbmRpdmlkdWFsbHkuJyxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoaXNCaW9mb3JtYXRzMlJhd0xheW91dChub2RlKSkge1xuICAgICAgbm90ZShjb250ZXh0LCB7XG4gICAgICAgIGtpbmQ6ICdza2lwcGVkJyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogJ2Jpb2Zvcm1hdHMycmF3IGNvbnRhaW5lcjogbGlzdGluZyBpdHMgaW1hZ2Ugc2VyaWVzIGluZGl2aWR1YWxseS4nLFxuICAgICAgfSk7XG4gICAgfVxuICAgIC8vIEFueSBvdGhlciBncm91cCBcdTIwMTQgYSB3ZWxsLCBhIHBsYWluIGNvbnRhaW5lciBcdTIwMTQgZmFsbHMgdGhyb3VnaCB0byB0aGVcbiAgICAvLyByZWN1cnNpb24gYmVsb3csIHdoaWNoIGlzIGhvdyBuZXN0ZWQgZGF0YXNldHMgYXJlIGZvdW5kLlxuICB9XG5cbiAgaWYgKGRlcHRoID49IGNvbnRleHQubGltaXRzLm1heERlcHRoKSB7XG4gICAgcmVwb3J0TGltaXQoXG4gICAgICBjb250ZXh0LFxuICAgICAgJ2RlcHRoJyxcbiAgICAgIGBTdG9wcGVkIGF0ICR7Y29udGV4dC5saW1pdHMubWF4RGVwdGh9IGZvbGRlcnMgZGVlcDsgZGVlcGVyIGRhdGFzZXRzIHdlcmUgbm90IHNlYXJjaGVkLmAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgY2hpbGRyZW46IEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVbXTtcbiAgdHJ5IHtcbiAgICBjaGlsZHJlbiA9IGF3YWl0IGNoaWxkRGlyZWN0b3JpZXMoY29udGV4dCwgZGlyZWN0b3J5LCByZWxhdGl2ZVBhdGgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG5vdGUoY29udGV4dCwge1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IGRpc3BsYXlQYXRoKHJlbGF0aXZlUGF0aCwgY29udGV4dC5tb3VudCksXG4gICAgICBtZXNzYWdlOiBgQ291bGQgbm90IGxpc3QgdGhpcyBmb2xkZXI6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWAsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgIGNvbnN0IGNoaWxkUGF0aCA9IHJlbGF0aXZlUGF0aCA9PT0gJycgPyBjaGlsZC5uYW1lIDogYCR7cmVsYXRpdmVQYXRofS8ke2NoaWxkLm5hbWV9YDtcbiAgICBhd2FpdCB3YWxrKGNvbnRleHQsIGNoaWxkLCBjaGlsZFBhdGgsIGRlcHRoICsgMSk7XG4gIH1cbn1cblxuLyoqIERpc2NvdmVyIGRhdGFzZXRzIGluIGEgc2luZ2xlIG1vdW50LiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRpc2NvdmVySW5Nb3VudChcbiAgbW91bnQ6IE1vdW50LFxuICBvcHRpb25zOiBEaXNjb3ZlcnlPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPERpc2NvdmVyeVJlc3VsdD4ge1xuICBjb25zdCBjb250ZXh0OiBXYWxrQ29udGV4dCA9IHtcbiAgICBtb3VudCxcbiAgICBidWlsZFVybDogb3B0aW9ucy51cmxCdWlsZGVyID8/IGxvY2FsVXJsLFxuICAgIGxpbWl0czogeyAuLi5ERUZBVUxUX0xJTUlUUywgLi4ub3B0aW9ucy5saW1pdHMgfSxcbiAgICBkYXRhc2V0czogW10sXG4gICAgbm90ZXM6IFtdLFxuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogMCxcbiAgICBsaW1pdFJlcG9ydGVkOiBuZXcgU2V0KCksXG4gICAgb3B0aW9ucyxcbiAgfTtcblxuICB0cnkge1xuICAgIGF3YWl0IHdhbGsoY29udGV4dCwgbW91bnQuaGFuZGxlLCAnJywgMCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKG9wdGlvbnMuc2lnbmFsPy5hYm9ydGVkKSB0aHJvdyBlcnJvcjtcbiAgICBjb250ZXh0Lm5vdGVzLnB1c2goe1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IG1vdW50Lm5hbWUsXG4gICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGRhdGFzZXRzOiBjb250ZXh0LmRhdGFzZXRzLFxuICAgIG5vdGVzOiBjb250ZXh0Lm5vdGVzLFxuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogY29udGV4dC5kaXJlY3Rvcmllc1NjYW5uZWQsXG4gIH07XG59XG5cbi8qKlxuICogRGlzY292ZXIgZGF0YXNldHMgYWNyb3NzIHNldmVyYWwgbW91bnRzLCBhY2N1bXVsYXRpbmcgcHJvZ3Jlc3Mgc28gYSBkcm9wIG9mXG4gKiBtdWx0aXBsZSBmb2xkZXJzIHJlYWRzIGFzIG9uZSBvcGVyYXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlckluTW91bnRzKFxuICBtb3VudHM6IE1vdW50W10sXG4gIG9wdGlvbnM6IERpc2NvdmVyeU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8RGlzY292ZXJ5UmVzdWx0PiB7XG4gIGNvbnN0IGRhdGFzZXRzOiBEaXNjb3ZlcmVkRGF0YXNldFtdID0gW107XG4gIGNvbnN0IG5vdGVzOiBEaXNjb3ZlcnlOb3RlW10gPSBbXTtcbiAgbGV0IGRpcmVjdG9yaWVzU2Nhbm5lZCA9IDA7XG5cbiAgZm9yIChjb25zdCBtb3VudCBvZiBtb3VudHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQobW91bnQsIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBvblByb2dyZXNzOiBvcHRpb25zLm9uUHJvZ3Jlc3NcbiAgICAgICAgPyAocHJvZ3Jlc3MpID0+XG4gICAgICAgICAgICBvcHRpb25zLm9uUHJvZ3Jlc3M/Lih7XG4gICAgICAgICAgICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogZGlyZWN0b3JpZXNTY2FubmVkICsgcHJvZ3Jlc3MuZGlyZWN0b3JpZXNTY2FubmVkLFxuICAgICAgICAgICAgICBkYXRhc2V0c0ZvdW5kOiBkYXRhc2V0cy5sZW5ndGggKyBwcm9ncmVzcy5kYXRhc2V0c0ZvdW5kLFxuICAgICAgICAgICAgICBjdXJyZW50UGF0aDogcHJvZ3Jlc3MuY3VycmVudFBhdGgsXG4gICAgICAgICAgICB9KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICBkYXRhc2V0cy5wdXNoKC4uLnJlc3VsdC5kYXRhc2V0cyk7XG4gICAgbm90ZXMucHVzaCguLi5yZXN1bHQubm90ZXMpO1xuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZCArPSByZXN1bHQuZGlyZWN0b3JpZXNTY2FubmVkO1xuICB9XG5cbiAgcmV0dXJuIHsgZGF0YXNldHMsIG5vdGVzLCBkaXJlY3Rvcmllc1NjYW5uZWQgfTtcbn1cbiIsICIvKipcbiAqIEJ1aWxkcyBhbiBvbi1kaXNrIHRyZWUgZXhlcmNpc2luZyB0aGUgbGF5b3V0cyBkaXNjb3ZlcnkgaGFzIHRvIHRlbGwgYXBhcnQ6XG4gKiBaYXJyIHYyIGFuZCB2MyBtdWx0aXNjYWxlcywgcmVzb2x1dGlvbiBsZXZlbHMgdGhhdCBtdXN0IE5PVCBiZSBtaXN0YWtlbiBmb3JcbiAqIGRhdGFzZXRzLCBhIGJhcmUgYXJyYXksIGFuIEhDUyBwbGF0ZSwgYW5kIGFzc29ydGVkIG5vaXNlLlxuICovXG5pbXBvcnQgeyBwcm9taXNlcyBhcyBmcyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgbWtkdGVtcCB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVKc29uKHBhdGg6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZnMubWtkaXIoam9pbihwYXRoLCAnLi4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShwYXRoLCBKU09OLnN0cmluZ2lmeSh2YWx1ZSwgbnVsbCwgMikpO1xufVxuXG4vKiogQSB2MiBtdWx0aXNjYWxlIGltYWdlIHdpdGggdHdvIHJlc29sdXRpb24gbGV2ZWxzIGFuZCByZWFsIGNodW5rIGZpbGVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFrZVYySW1hZ2Uocm9vdDogc3RyaW5nLCBsZXZlbHMgPSAyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsICcuemdyb3VwJyksIHsgemFycl9mb3JtYXQ6IDIgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsICcuemF0dHJzJyksIHtcbiAgICBtdWx0aXNjYWxlczogW1xuICAgICAge1xuICAgICAgICB2ZXJzaW9uOiAnMC40JyxcbiAgICAgICAgbmFtZTogJ2V4YW1wbGUnLFxuICAgICAgICBheGVzOiBbXG4gICAgICAgICAgeyBuYW1lOiAnYycsIHR5cGU6ICdjaGFubmVsJyB9LFxuICAgICAgICAgIHsgbmFtZTogJ3knLCB0eXBlOiAnc3BhY2UnLCB1bml0OiAnbWljcm9tZXRlcicgfSxcbiAgICAgICAgICB7IG5hbWU6ICd4JywgdHlwZTogJ3NwYWNlJywgdW5pdDogJ21pY3JvbWV0ZXInIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGRhdGFzZXRzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBsZXZlbHMgfSwgKF8sIGluZGV4KSA9PiAoe1xuICAgICAgICAgIHBhdGg6IFN0cmluZyhpbmRleCksXG4gICAgICAgICAgY29vcmRpbmF0ZVRyYW5zZm9ybWF0aW9uczogW3sgdHlwZTogJ3NjYWxlJywgc2NhbGU6IFsxLCAyICoqIGluZGV4LCAyICoqIGluZGV4XSB9XSxcbiAgICAgICAgfSkpLFxuICAgICAgfSxcbiAgICBdLFxuICB9KTtcblxuICBmb3IgKGxldCBsZXZlbCA9IDA7IGxldmVsIDwgbGV2ZWxzOyBsZXZlbCArPSAxKSB7XG4gICAgY29uc3Qgc2l6ZSA9IDY0ID4+IGxldmVsO1xuICAgIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsIFN0cmluZyhsZXZlbCksICcuemFycmF5JyksIHtcbiAgICAgIHphcnJfZm9ybWF0OiAyLFxuICAgICAgc2hhcGU6IFsyLCBzaXplLCBzaXplXSxcbiAgICAgIGNodW5rczogWzEsIHNpemUsIHNpemVdLFxuICAgICAgZHR5cGU6ICc8dTInLFxuICAgICAgY29tcHJlc3NvcjogbnVsbCxcbiAgICAgIGZpbGxfdmFsdWU6IDAsXG4gICAgICBvcmRlcjogJ0MnLFxuICAgICAgZmlsdGVyczogbnVsbCxcbiAgICB9KTtcbiAgICAvLyBDaHVuayBrZXlzIHVzZSBuZXN0ZWQgZGlyZWN0b3JpZXMsIHRoZSBzaGFwZSB0aGF0IG11c3QgbmV2ZXIgYmUgd2Fsa2VkXG4gICAgLy8gaW50byBhcyBpZiBpdCB3ZXJlIGEgZGF0YXNldCBoaWVyYXJjaHkuXG4gICAgZm9yIChsZXQgY2hhbm5lbCA9IDA7IGNoYW5uZWwgPCAyOyBjaGFubmVsICs9IDEpIHtcbiAgICAgIGNvbnN0IGNodW5rUGF0aCA9IGpvaW4ocm9vdCwgU3RyaW5nKGxldmVsKSwgU3RyaW5nKGNoYW5uZWwpLCAnMCcsICcwJyk7XG4gICAgICBhd2FpdCBmcy5ta2Rpcihqb2luKGNodW5rUGF0aCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgYXdhaXQgZnMud3JpdGVGaWxlKGNodW5rUGF0aCwgQnVmZmVyLmFsbG9jKHNpemUgKiBzaXplICogMiwgbGV2ZWwgKyAxKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKiBBIHYzIG11bHRpc2NhbGUgaW1hZ2Ugd2l0aCBPTUUgbWV0YWRhdGEgdW5kZXIgYGF0dHJpYnV0ZXMub21lYC4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1ha2VWM0ltYWdlKHJvb3Q6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCB3cml0ZUpzb24oam9pbihyb290LCAnemFyci5qc29uJyksIHtcbiAgICB6YXJyX2Zvcm1hdDogMyxcbiAgICBub2RlX3R5cGU6ICdncm91cCcsXG4gICAgYXR0cmlidXRlczoge1xuICAgICAgb21lOiB7XG4gICAgICAgIHZlcnNpb246ICcwLjUnLFxuICAgICAgICBtdWx0aXNjYWxlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICd2MyBleGFtcGxlJyxcbiAgICAgICAgICAgIGF4ZXM6IFtcbiAgICAgICAgICAgICAgeyBuYW1lOiAneicsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgICAgeyBuYW1lOiAneScsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgICAgeyBuYW1lOiAneCcsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBkYXRhc2V0czogW1xuICAgICAgICAgICAgICB7IHBhdGg6ICcwJywgY29vcmRpbmF0ZVRyYW5zZm9ybWF0aW9uczogW3sgdHlwZTogJ3NjYWxlJywgc2NhbGU6IFsxLCAxLCAxXSB9XSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocm9vdCwgJzAnLCAnemFyci5qc29uJyksIHtcbiAgICB6YXJyX2Zvcm1hdDogMyxcbiAgICBub2RlX3R5cGU6ICdhcnJheScsXG4gICAgc2hhcGU6IFs4LCAzMiwgMzJdLFxuICAgIGRhdGFfdHlwZTogJ3VpbnQ4JyxcbiAgICBjaHVua19ncmlkOiB7IG5hbWU6ICdyZWd1bGFyJywgY29uZmlndXJhdGlvbjogeyBjaHVua19zaGFwZTogWzgsIDMyLCAzMl0gfSB9LFxuICAgIGNodW5rX2tleV9lbmNvZGluZzogeyBuYW1lOiAnZGVmYXVsdCcgfSxcbiAgICBjb2RlY3M6IFt7IG5hbWU6ICdieXRlcycsIGNvbmZpZ3VyYXRpb246IHsgZW5kaWFuOiAnbGl0dGxlJyB9IH1dLFxuICAgIGZpbGxfdmFsdWU6IDAsXG4gIH0pO1xuICBjb25zdCBjaHVuayA9IGpvaW4ocm9vdCwgJzAnLCAnYycsICcwJywgJzAnLCAnMCcpO1xuICBhd2FpdCBmcy5ta2Rpcihqb2luKGNodW5rLCAnLi4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShjaHVuaywgQnVmZmVyLmFsbG9jKDggKiAzMiAqIDMyLCA3KSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRml4dHVyZSB7XG4gIHJvb3Q6IHN0cmluZztcbiAgY2xlYW51cDogKCkgPT4gUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1ha2VGaXh0dXJlKCk6IFByb21pc2U8Rml4dHVyZT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWtkdGVtcChqb2luKHRtcGRpcigpLCAnb21lLXphcnItcG9ydGFsLScpKTtcblxuICAvLyBBIGRhdGFzZXQgZGlyZWN0bHkgdW5kZXIgdGhlIGRyb3Agcm9vdC5cbiAgYXdhaXQgbWFrZVYySW1hZ2Uoam9pbihyb290LCAndjItaW1hZ2Uub21lLnphcnInKSk7XG5cbiAgLy8gQSBkYXRhc2V0IGJ1cmllZCBhIGZldyBwbGFpbiBmb2xkZXJzIGRvd24uXG4gIGF3YWl0IG1ha2VWM0ltYWdlKGpvaW4ocm9vdCwgJ25lc3RlZCcsICdkZWVwZXInLCAndjMtaW1hZ2Uub21lLnphcnInKSk7XG5cbiAgLy8gQSBiYXJlIGFycmF5OiB2YWxpZCBaYXJyLCBidXQgbm90IGFuIE9NRS1aYXJyIGltYWdlLlxuICBhd2FpdCB3cml0ZUpzb24oam9pbihyb290LCAnYmFyZS1hcnJheS56YXJyJywgJy56YXJyYXknKSwge1xuICAgIHphcnJfZm9ybWF0OiAyLFxuICAgIHNoYXBlOiBbNCwgNF0sXG4gICAgY2h1bmtzOiBbNCwgNF0sXG4gICAgZHR5cGU6ICc8ZjQnLFxuICAgIGNvbXByZXNzb3I6IG51bGwsXG4gICAgZmlsbF92YWx1ZTogMCxcbiAgICBvcmRlcjogJ0MnLFxuICAgIGZpbHRlcnM6IG51bGwsXG4gIH0pO1xuXG4gIC8vIEFuIEhDUyBwbGF0ZTogbm90IG9wZW5hYmxlIGl0c2VsZiwgYnV0IGl0cyBmaWVsZHMgb2YgdmlldyBhcmUuXG4gIGNvbnN0IHBsYXRlID0gam9pbihyb290LCAncGxhdGUub21lLnphcnInKTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocGxhdGUsICcuemdyb3VwJyksIHsgemFycl9mb3JtYXQ6IDIgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHBsYXRlLCAnLnphdHRycycpLCB7XG4gICAgcGxhdGU6IHtcbiAgICAgIHZlcnNpb246ICcwLjQnLFxuICAgICAgY29sdW1uczogW3sgbmFtZTogJzEnIH1dLFxuICAgICAgcm93czogW3sgbmFtZTogJ0EnIH1dLFxuICAgICAgd2VsbHM6IFt7IHBhdGg6ICdBLzEnLCByb3dJbmRleDogMCwgY29sdW1uSW5kZXg6IDAgfV0sXG4gICAgfSxcbiAgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHBsYXRlLCAnQScsICcxJywgJy56Z3JvdXAnKSwgeyB6YXJyX2Zvcm1hdDogMiB9KTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocGxhdGUsICdBJywgJzEnLCAnLnphdHRycycpLCB7XG4gICAgd2VsbDogeyB2ZXJzaW9uOiAnMC40JywgaW1hZ2VzOiBbeyBwYXRoOiAnMCcgfV0gfSxcbiAgfSk7XG4gIGF3YWl0IG1ha2VWMkltYWdlKGpvaW4ocGxhdGUsICdBJywgJzEnLCAnMCcpLCAxKTtcblxuICAvLyBBIHB5cmFtaWQgd2hvc2UgY29hcnNlc3QgbGV2ZWwgaXMgc3RpbGwgZmFyIHRvbyBsYXJnZSB0byBwcm9qZWN0LlxuICAvLyBPbmx5IG1ldGFkYXRhIGlzIG5lZWRlZDogZWxpZ2liaWxpdHkgbmV2ZXIgcmVhZHMgY2h1bmsgZGF0YS5cbiAgY29uc3QgYmlnID0gam9pbihyb290LCAnYmlnLXB5cmFtaWQub21lLnphcnInKTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4oYmlnLCAnLnpncm91cCcpLCB7IHphcnJfZm9ybWF0OiAyIH0pO1xuICBhd2FpdCB3cml0ZUpzb24oam9pbihiaWcsICcuemF0dHJzJyksIHtcbiAgICBtdWx0aXNjYWxlczogW1xuICAgICAge1xuICAgICAgICB2ZXJzaW9uOiAnMC40JyxcbiAgICAgICAgYXhlczogW1xuICAgICAgICAgIHsgbmFtZTogJ3knLCB0eXBlOiAnc3BhY2UnIH0sXG4gICAgICAgICAgeyBuYW1lOiAneCcsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgXSxcbiAgICAgICAgZGF0YXNldHM6IFt7IHBhdGg6ICcwJyB9XSxcbiAgICAgIH0sXG4gICAgXSxcbiAgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKGJpZywgJzAnLCAnLnphcnJheScpLCB7XG4gICAgemFycl9mb3JtYXQ6IDIsXG4gICAgc2hhcGU6IFs4MTkyLCA4MTkyXSxcbiAgICBjaHVua3M6IFs1MTIsIDUxMl0sXG4gICAgZHR5cGU6ICc8dTInLFxuICAgIGNvbXByZXNzb3I6IG51bGwsXG4gICAgZmlsbF92YWx1ZTogMCxcbiAgICBvcmRlcjogJ0MnLFxuICAgIGZpbHRlcnM6IG51bGwsXG4gIH0pO1xuXG4gIC8vIEEgZGF0YXNldCB0aGF0IHNoaXBzIGl0cyBvd24gdGh1bWJuYWlscyB2aWEgdGhlIHphcnIgY29udmVudGlvbi5cbiAgY29uc3QgdGh1bWJlZCA9IGpvaW4ocm9vdCwgJ3RodW1iZWQub21lLnphcnInKTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4odGh1bWJlZCwgJ3phcnIuanNvbicpLCB7XG4gICAgemFycl9mb3JtYXQ6IDMsXG4gICAgbm9kZV90eXBlOiAnZ3JvdXAnLFxuICAgIGF0dHJpYnV0ZXM6IHtcbiAgICAgIHRodW1ibmFpbHM6IFt7IHdpZHRoOiAyNTYsIGhlaWdodDogMjU2LCBtZWRpYV90eXBlOiAnaW1hZ2UvcG5nJywgcGF0aDogJ3RodW1iLnBuZycgfV0sXG4gICAgICBvbWU6IHtcbiAgICAgICAgdmVyc2lvbjogJzAuNScsXG4gICAgICAgIG11bHRpc2NhbGVzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgYXhlczogW1xuICAgICAgICAgICAgICB7IG5hbWU6ICd5JywgdHlwZTogJ3NwYWNlJyB9LFxuICAgICAgICAgICAgICB7IG5hbWU6ICd4JywgdHlwZTogJ3NwYWNlJyB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGRhdGFzZXRzOiBbeyBwYXRoOiAnMCcgfV0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHRodW1iZWQsICcwJywgJ3phcnIuanNvbicpLCB7XG4gICAgemFycl9mb3JtYXQ6IDMsXG4gICAgbm9kZV90eXBlOiAnYXJyYXknLFxuICAgIHNoYXBlOiBbMTYsIDE2XSxcbiAgICBkYXRhX3R5cGU6ICd1aW50OCcsXG4gICAgY2h1bmtfZ3JpZDogeyBuYW1lOiAncmVndWxhcicsIGNvbmZpZ3VyYXRpb246IHsgY2h1bmtfc2hhcGU6IFsxNiwgMTZdIH0gfSxcbiAgICBjaHVua19rZXlfZW5jb2Rpbmc6IHsgbmFtZTogJ2RlZmF1bHQnIH0sXG4gICAgY29kZWNzOiBbeyBuYW1lOiAnYnl0ZXMnLCBjb25maWd1cmF0aW9uOiB7IGVuZGlhbjogJ2xpdHRsZScgfSB9XSxcbiAgICBmaWxsX3ZhbHVlOiAwLFxuICB9KTtcblxuICAvLyBOb2lzZSB0aGF0IG11c3QgYmUgaWdub3JlZC5cbiAgYXdhaXQgZnMud3JpdGVGaWxlKGpvaW4ocm9vdCwgJ1JFQURNRS50eHQnKSwgJ25vdCBhIGRhdGFzZXQnKTtcbiAgYXdhaXQgZnMubWtkaXIoam9pbihyb290LCAnX19NQUNPU1gnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLm1rZGlyKGpvaW4ocm9vdCwgJy5oaWRkZW4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShqb2luKHJvb3QsICcuaGlkZGVuJywgJ3NlY3JldCcpLCAnaWdub3JlZCcpO1xuXG4gIHJldHVybiB7XG4gICAgcm9vdCxcbiAgICBjbGVhbnVwOiAoKSA9PiBmcy5ybShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSksXG4gIH07XG59XG4iLCAiLyoqXG4gKiBBIGBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlYCBpbXBsZW1lbnRhdGlvbiBiYWNrZWQgYnkgbm9kZTpmcy5cbiAqXG4gKiBUaGUgcG9ydGFsJ3MgZGlzY292ZXJ5IGFuZCBzZXJ2aW5nIGxheWVycyBhcmUgd3JpdHRlbiBhZ2FpbnN0IHRoZSBGaWxlXG4gKiBTeXN0ZW0gQWNjZXNzIEFQSSBhbmQgbm90aGluZyBlbHNlLCBzbyBhIGZhaXRoZnVsIGFkYXB0ZXIgbGV0cyBib3RoIGJlXG4gKiB0ZXN0ZWQgYWdhaW5zdCByZWFsIGRpcmVjdG9yeSB0cmVlcyB3aXRob3V0IGEgYnJvd3Nlci5cbiAqL1xuaW1wb3J0IHsgcHJvbWlzZXMgYXMgZnMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5mdW5jdGlvbiBub3RGb3VuZChuYW1lOiBzdHJpbmcpOiBET01FeGNlcHRpb24ge1xuICByZXR1cm4gbmV3IERPTUV4Y2VwdGlvbihgTm8gZW50cnkgbmFtZWQgJHtuYW1lfWAsICdOb3RGb3VuZEVycm9yJyk7XG59XG5cbmZ1bmN0aW9uIHR5cGVNaXNtYXRjaChuYW1lOiBzdHJpbmcpOiBET01FeGNlcHRpb24ge1xuICByZXR1cm4gbmV3IERPTUV4Y2VwdGlvbihgRW50cnkgJHtuYW1lfSBpcyB0aGUgd3JvbmcgdHlwZWAsICdUeXBlTWlzbWF0Y2hFcnJvcicpO1xufVxuXG5jbGFzcyBOb2RlRmlsZUhhbmRsZSB7XG4gIHJlYWRvbmx5IGtpbmQgPSAnZmlsZScgYXMgY29uc3Q7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgbmFtZTogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgcGF0aDogc3RyaW5nLFxuICApIHt9XG5cbiAgYXN5bmMgZ2V0RmlsZSgpOiBQcm9taXNlPEZpbGU+IHtcbiAgICBjb25zdCBbZGF0YSwgc3RhdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbZnMucmVhZEZpbGUodGhpcy5wYXRoKSwgZnMuc3RhdCh0aGlzLnBhdGgpXSk7XG4gICAgcmV0dXJuIG5ldyBGaWxlKFtkYXRhXSwgdGhpcy5uYW1lLCB7IGxhc3RNb2RpZmllZDogc3RhdC5tdGltZU1zIH0pO1xuICB9XG59XG5cbmNsYXNzIE5vZGVEaXJlY3RvcnlIYW5kbGUge1xuICByZWFkb25seSBraW5kID0gJ2RpcmVjdG9yeScgYXMgY29uc3Q7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgbmFtZTogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgcGF0aDogc3RyaW5nLFxuICApIHt9XG5cbiAgYXN5bmMgZ2V0RmlsZUhhbmRsZShuYW1lOiBzdHJpbmcpOiBQcm9taXNlPE5vZGVGaWxlSGFuZGxlPiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gam9pbih0aGlzLnBhdGgsIG5hbWUpO1xuICAgIGxldCBzdGF0O1xuICAgIHRyeSB7XG4gICAgICBzdGF0ID0gYXdhaXQgZnMuc3RhdCh0YXJnZXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbm90Rm91bmQobmFtZSk7XG4gICAgfVxuICAgIGlmICghc3RhdC5pc0ZpbGUoKSkgdGhyb3cgdHlwZU1pc21hdGNoKG5hbWUpO1xuICAgIHJldHVybiBuZXcgTm9kZUZpbGVIYW5kbGUobmFtZSwgdGFyZ2V0KTtcbiAgfVxuXG4gIGFzeW5jIGdldERpcmVjdG9yeUhhbmRsZShuYW1lOiBzdHJpbmcpOiBQcm9taXNlPE5vZGVEaXJlY3RvcnlIYW5kbGU+IHtcbiAgICBjb25zdCB0YXJnZXQgPSBqb2luKHRoaXMucGF0aCwgbmFtZSk7XG4gICAgbGV0IHN0YXQ7XG4gICAgdHJ5IHtcbiAgICAgIHN0YXQgPSBhd2FpdCBmcy5zdGF0KHRhcmdldCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBub3RGb3VuZChuYW1lKTtcbiAgICB9XG4gICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIHRocm93IHR5cGVNaXNtYXRjaChuYW1lKTtcbiAgICByZXR1cm4gbmV3IE5vZGVEaXJlY3RvcnlIYW5kbGUobmFtZSwgdGFyZ2V0KTtcbiAgfVxuXG4gIGFzeW5jICp2YWx1ZXMoKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPE5vZGVEaXJlY3RvcnlIYW5kbGUgfCBOb2RlRmlsZUhhbmRsZT4ge1xuICAgIGNvbnN0IGVudHJpZXMgPSBhd2FpdCBmcy5yZWFkZGlyKHRoaXMucGF0aCwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gam9pbih0aGlzLnBhdGgsIGVudHJ5Lm5hbWUpO1xuICAgICAgeWllbGQgZW50cnkuaXNEaXJlY3RvcnkoKVxuICAgICAgICA/IG5ldyBOb2RlRGlyZWN0b3J5SGFuZGxlKGVudHJ5Lm5hbWUsIHRhcmdldClcbiAgICAgICAgOiBuZXcgTm9kZUZpbGVIYW5kbGUoZW50cnkubmFtZSwgdGFyZ2V0KTtcbiAgICB9XG4gIH1cblxuICBhc3luYyAqZW50cmllcygpOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8W3N0cmluZywgTm9kZURpcmVjdG9yeUhhbmRsZSB8IE5vZGVGaWxlSGFuZGxlXT4ge1xuICAgIGZvciBhd2FpdCAoY29uc3QgaGFuZGxlIG9mIHRoaXMudmFsdWVzKCkpIHlpZWxkIFtoYW5kbGUubmFtZSwgaGFuZGxlXTtcbiAgfVxuXG4gIGFzeW5jICprZXlzKCk6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxzdHJpbmc+IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGhhbmRsZSBvZiB0aGlzLnZhbHVlcygpKSB5aWVsZCBoYW5kbGUubmFtZTtcbiAgfVxuXG4gIGFzeW5jIHF1ZXJ5UGVybWlzc2lvbigpOiBQcm9taXNlPFBlcm1pc3Npb25TdGF0ZT4ge1xuICAgIHJldHVybiAnZ3JhbnRlZCc7XG4gIH1cblxuICBhc3luYyByZXF1ZXN0UGVybWlzc2lvbigpOiBQcm9taXNlPFBlcm1pc3Npb25TdGF0ZT4ge1xuICAgIHJldHVybiAnZ3JhbnRlZCc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRpcmVjdG9yeUhhbmRsZShwYXRoOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlIHtcbiAgcmV0dXJuIG5ldyBOb2RlRGlyZWN0b3J5SGFuZGxlKFxuICAgIG5hbWUgPz8gcGF0aC5zbGljZShwYXRoLmxhc3RJbmRleE9mKCcvJykgKyAxKSxcbiAgICBwYXRoLFxuICApIGFzIHVua25vd24gYXMgRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxPQUFPLFFBQVEsVUFBVSxVQUFVO0FBQzVDLFNBQVMsUUFBQUEsYUFBWTs7O0FDZWQsSUFBTSxnQkFBZ0I7QUFVdEIsU0FBUyxnQkFBZ0JDLFdBQWtCLFNBQXlCO0FBQ3pFLFNBQU8sR0FBR0EsU0FBUSxHQUFHLE9BQU87QUFDOUI7OztBQ1hBLElBQUksV0FBMEI7QUFVdkIsU0FBUyxjQUFzQjtBQUNwQyxTQUFPLFlBQVksSUFBSSxJQUFJLE1BQU0sU0FBUyxJQUFJLEVBQUU7QUFDbEQ7QUFvRUEsU0FBUyxXQUFXLE1BQXNCO0FBQ3hDLFNBQU8sS0FBSyxNQUFNLEdBQUcsRUFBRSxPQUFPLE9BQU8sRUFBRSxJQUFJLGtCQUFrQixFQUFFLEtBQUssR0FBRztBQUN6RTtBQVdPLFNBQVMsU0FBUyxTQUFpQixlQUFlLElBQVk7QUFDbkUsUUFBTSxTQUFTLGdCQUFnQixZQUFZLEdBQUcsYUFBYTtBQUMzRCxTQUFPLElBQUk7QUFBQSxJQUNULEdBQUcsTUFBTSxHQUFHLG1CQUFtQixPQUFPLENBQUMsSUFBSSxXQUFXLFlBQVksQ0FBQztBQUFBLElBQ25FLFNBQVM7QUFBQSxFQUNYLEVBQUU7QUFDSjs7O0FDbkdPLElBQU0sdUJBQXVCLEtBQUs7QUFPbEMsSUFB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QUFFRCxLQUFHLHdEQUF3RCxZQUFZO0FBQ3JFLFVBQU0sVUFBVSxNQUFNLGdCQUFnQixTQUFTLFFBQVEsTUFBTSxNQUFNLEdBQUc7QUFBQSxNQUNwRTtBQUFBLE1BQ0EsUUFBUSxFQUFFLFVBQVUsRUFBRTtBQUFBLElBQ3hCLENBQUM7QUFDRCxXQUFPO0FBQUEsTUFDTCxRQUFRLFNBQVMsSUFBSSxDQUFDLFlBQVksUUFBUSxZQUFZLEVBQUUsS0FBSztBQUFBLE1BQzdELENBQUMsd0JBQXdCLG9CQUFvQixtQkFBbUI7QUFBQSxJQUNsRTtBQUNBLFdBQU8sR0FBRyxRQUFRLE1BQU0sS0FBSyxDQUFDQSxVQUFTQSxNQUFLLFNBQVMsT0FBTyxDQUFDO0FBQUEsRUFDL0QsQ0FBQztBQUVELEtBQUcsZ0NBQWdDLFlBQVk7QUFDN0MsVUFBTSxPQUFpQixDQUFDO0FBQ3hCLFVBQU0sZ0JBQWdCLFNBQVMsUUFBUSxNQUFNLE1BQU0sR0FBRztBQUFBLE1BQ3BEO0FBQUEsTUFDQSxZQUFZLENBQUMsYUFBYSxLQUFLLEtBQUssU0FBUyxrQkFBa0I7QUFBQSxJQUNqRSxDQUFDO0FBQ0QsV0FBTyxHQUFHLEtBQUssU0FBUyxDQUFDO0FBQ3pCLFdBQU8sVUFBVSxNQUFNLENBQUMsR0FBRyxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsTUFBTSxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQ3hELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogWyJqb2luIiwgImJhc2VQYXRoIiwgIm5vdGUiLCAiZnMiLCAiam9pbiIsICJub3RlIiwgImpvaW4iXQp9Cg==
