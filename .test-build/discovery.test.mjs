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
async function readScaleInfo(directory, multiscale, format) {
  const path = multiscale.paths[0];
  if (!path) return {};
  try {
    let current = directory;
    for (const segment of path.split("/").filter(Boolean)) {
      current = await current.getDirectoryHandle(segment);
    }
    const raw = format === 3 ? await readJsonFile(current, "zarr.json") : await readJsonFile(current, ".zarray");
    return raw ? readArrayInfo(raw) : {};
  } catch {
    return {};
  }
}
async function recordDataset(context, directory, relativePath, node, multiscale) {
  const { mount } = context;
  const { shape, dtype } = await readScaleInfo(directory, multiscale, node.format);
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
    scaleCount: multiscale.paths.length || void 0
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
      ["nested/deeper/v3-image.ome.zarr", "plate.ome.zarr/A/1/0", "v2-image.ome.zarr"]
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
      result.directoriesScanned < 20,
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
      shallow.datasets.map((dataset) => dataset.relativePath),
      ["v2-image.ome.zarr"]
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvZGlzY292ZXJ5LnRlc3QudHMiLCAiLi4vc3JjL3Zmcy9wcm90b2NvbC50cyIsICIuLi9zcmMvdmZzL2NsaWVudC50cyIsICIuLi9zcmMvZGlzY292ZXJ5L3phcnItbWV0YWRhdGEudHMiLCAiLi4vc3JjL2Rpc2NvdmVyeS90eXBlcy50cyIsICIuLi9zcmMvZGlzY292ZXJ5L2Rpc2NvdmVyLnRzIiwgIi4uL3Rlc3RzL2ZpeHR1cmVzLnRzIiwgIi4uL3Rlc3RzL25vZGUtaGFuZGxlcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgYWZ0ZXIsIGJlZm9yZSwgZGVzY3JpYmUsIGl0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5pbXBvcnQgeyBkaXNjb3ZlckluTW91bnQgfSBmcm9tICcuLi9zcmMvZGlzY292ZXJ5L2Rpc2NvdmVyJztcbmltcG9ydCB0eXBlIHsgRGlzY292ZXJlZERhdGFzZXQsIERpc2NvdmVyeVJlc3VsdCB9IGZyb20gJy4uL3NyYy9kaXNjb3ZlcnkvdHlwZXMnO1xuaW1wb3J0IHR5cGUgeyBNb3VudCB9IGZyb20gJy4uL3NyYy9tb3VudHMvcmVnaXN0cnknO1xuaW1wb3J0IHsgbWFrZUZpeHR1cmUsIHR5cGUgRml4dHVyZSB9IGZyb20gJy4vZml4dHVyZXMnO1xuaW1wb3J0IHsgZGlyZWN0b3J5SGFuZGxlIH0gZnJvbSAnLi9ub2RlLWhhbmRsZXMnO1xuXG5jb25zdCB1cmxCdWlsZGVyID0gKG1vdW50SWQ6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcpID0+XG4gIGBodHRwczovL2V4YW1wbGUudGVzdC9fbG9jYWwvJHttb3VudElkfS8ke3JlbGF0aXZlUGF0aH1gO1xuXG5mdW5jdGlvbiBtb3VudEZvcihwYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IE1vdW50IHtcbiAgcmV0dXJuIHsgaWQ6ICdtMScsIG5hbWUsIGhhbmRsZTogZGlyZWN0b3J5SGFuZGxlKHBhdGgsIG5hbWUpLCBjcmVhdGVkQXQ6IDAgfTtcbn1cblxuZnVuY3Rpb24gYnlOYW1lKHJlc3VsdDogRGlzY292ZXJ5UmVzdWx0LCBuYW1lOiBzdHJpbmcpOiBEaXNjb3ZlcmVkRGF0YXNldCB7XG4gIGNvbnN0IGZvdW5kID0gcmVzdWx0LmRhdGFzZXRzLmZpbmQoKGRhdGFzZXQpID0+IGRhdGFzZXQubmFtZSA9PT0gbmFtZSk7XG4gIGFzc2VydC5vayhmb3VuZCwgYGV4cGVjdGVkIGEgZGF0YXNldCBuYW1lZCAke25hbWV9LCBnb3QgJHtyZXN1bHQuZGF0YXNldHMubWFwKChkKSA9PiBkLm5hbWUpLmpvaW4oJywgJyl9YCk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZGVzY3JpYmUoJ09NRS1aYXJyIGRpc2NvdmVyeScsICgpID0+IHtcbiAgbGV0IGZpeHR1cmU6IEZpeHR1cmU7XG4gIGxldCByZXN1bHQ6IERpc2NvdmVyeVJlc3VsdDtcblxuICBiZWZvcmUoYXN5bmMgKCkgPT4ge1xuICAgIGZpeHR1cmUgPSBhd2FpdCBtYWtlRml4dHVyZSgpO1xuICAgIHJlc3VsdCA9IGF3YWl0IGRpc2NvdmVySW5Nb3VudChtb3VudEZvcihmaXh0dXJlLnJvb3QsICdkcm9wJyksIHsgdXJsQnVpbGRlciB9KTtcbiAgfSk7XG5cbiAgYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGZpeHR1cmUuY2xlYW51cCgpO1xuICB9KTtcblxuICBpdCgnZmluZHMgZXZlcnkgbXVsdGlzY2FsZSBpbWFnZSBhbmQgbm90aGluZyBlbHNlJywgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICByZXN1bHQuZGF0YXNldHMubWFwKChkYXRhc2V0KSA9PiBkYXRhc2V0LnJlbGF0aXZlUGF0aCkuc29ydCgpLFxuICAgICAgWyduZXN0ZWQvZGVlcGVyL3YzLWltYWdlLm9tZS56YXJyJywgJ3BsYXRlLm9tZS56YXJyL0EvMS8wJywgJ3YyLWltYWdlLm9tZS56YXJyJ10sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ25ldmVyIHJlcG9ydHMgYSBkYXRhc2V0IG5lc3RlZCBpbnNpZGUgYW5vdGhlciBkYXRhc2V0JywgKCkgPT4ge1xuICAgIC8vIFRoZSB2MiBpbWFnZSBoYXMgbGV2ZWxzIGAwYCBhbmQgYDFgLCBlYWNoIGEgWmFyciBhcnJheSB3aXRoIGNodW5rXG4gICAgLy8gZGlyZWN0b3JpZXMgYmVsb3cgaXQ7IG5vbmUgbWF5IHN1cmZhY2UgYXMgYSBkYXRhc2V0IG9mIGl0cyBvd24uIFRlc3RpbmdcbiAgICAvLyBjb250YWlubWVudCByYXRoZXIgdGhhbiBwYXRoIHNoYXBlIGFsc28gY292ZXJzIGEgcGxhdGUncyBmaWVsZHMgb2YgdmlldyxcbiAgICAvLyB3aGljaCBsZWdpdGltYXRlbHkgc2l0IGF0IHBhdGhzIGxpa2UgYEEvMS8wYC5cbiAgICBmb3IgKGNvbnN0IG91dGVyIG9mIHJlc3VsdC5kYXRhc2V0cykge1xuICAgICAgZm9yIChjb25zdCBpbm5lciBvZiByZXN1bHQuZGF0YXNldHMpIHtcbiAgICAgICAgaWYgKG91dGVyID09PSBpbm5lcikgY29udGludWU7XG4gICAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgICBpbm5lci5yZWxhdGl2ZVBhdGguc3RhcnRzV2l0aChgJHtvdXRlci5yZWxhdGl2ZVBhdGh9L2ApLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIGAke2lubmVyLnJlbGF0aXZlUGF0aH0gaXMgbmVzdGVkIGluc2lkZSAke291dGVyLnJlbGF0aXZlUGF0aH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ3N0b3BzIGF0IHRoZSBtdWx0aXNjYWxlIHJvb3QgaW5zdGVhZCBvZiB3YWxraW5nIGl0cyBjaHVuayB0cmVlJywgKCkgPT4ge1xuICAgIC8vIDEyIGZvbGRlcnM6IHRoZSBkcm9wIHJvb3QsIHRocmVlIGRhdGFzZXQgcm9vdHMsIGFuZCB0aGUgcGxhaW4gZm9sZGVyc1xuICAgIC8vIGxlYWRpbmcgdG8gdGhlbS4gSWYgdGhlIHdhbGsgZGVzY2VuZGVkIGludG8gcmVzb2x1dGlvbiBsZXZlbHMgb3IgY2h1bmtcbiAgICAvLyBkaXJlY3RvcmllcyB0aGlzIG51bWJlciB3b3VsZCBiZSBmYXIgbGFyZ2VyLlxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5kaXJlY3Rvcmllc1NjYW5uZWQgPCAyMCxcbiAgICAgIGBzY2FubmVkICR7cmVzdWx0LmRpcmVjdG9yaWVzU2Nhbm5lZH0gZm9sZGVycywgZXhwZWN0ZWQgdGhlIHdhbGsgdG8gc3RvcCBhdCBkYXRhc2V0IHJvb3RzYCxcbiAgICApO1xuICB9KTtcblxuICBpdCgncmVhZHMgdjIgbWV0YWRhdGEsIGluY2x1ZGluZyBheGVzIGFuZCBhcnJheSBzaGFwZScsICgpID0+IHtcbiAgICBjb25zdCBkYXRhc2V0ID0gYnlOYW1lKHJlc3VsdCwgJ3YyLWltYWdlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQuemFyckZvcm1hdCwgMik7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGFzZXQub21lWmFyclZlcnNpb24sICcwLjQnKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRhdGFzZXQuYXhlcywgWydjJywgJ3knLCAneCddKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGRhdGFzZXQuc2hhcGUsIFsyLCA2NCwgNjRdKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5kdHlwZSwgJzx1MicpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhc2V0LnNjYWxlQ291bnQsIDIpO1xuICB9KTtcblxuICBpdCgncmVhZHMgdjMgbWV0YWRhdGEgbmVzdGVkIHVuZGVyIGF0dHJpYnV0ZXMub21lJywgKCkgPT4ge1xuICAgIGNvbnN0IGRhdGFzZXQgPSBieU5hbWUocmVzdWx0LCAndjMtaW1hZ2UnKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC56YXJyRm9ybWF0LCAzKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YXNldC5vbWVaYXJyVmVyc2lvbiwgJzAuNScpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZGF0YXNldC5heGVzLCBbJ3onLCAneScsICd4J10pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoZGF0YXNldC5zaGFwZSwgWzgsIDMyLCAzMl0pO1xuICAgIGFzc2VydC5lcXVhbChkYXRhc2V0LmR0eXBlLCAndWludDgnKTtcbiAgfSk7XG5cbiAgaXQoJ2J1aWxkcyB2aXJ0dWFsIFVSTHMgd2l0aCBhIHRyYWlsaW5nIHNsYXNoJywgKCkgPT4ge1xuICAgIGZvciAoY29uc3QgZGF0YXNldCBvZiByZXN1bHQuZGF0YXNldHMpIHtcbiAgICAgIGFzc2VydC5vayhkYXRhc2V0LnZpcnR1YWxVcmwuZW5kc1dpdGgoJy8nKSwgZGF0YXNldC52aXJ0dWFsVXJsKTtcbiAgICAgIGFzc2VydC5lcXVhbChkYXRhc2V0LnZpcnR1YWxVcmwsIGAke3VybEJ1aWxkZXIoJ20xJywgZGF0YXNldC5yZWxhdGl2ZVBhdGgpfS9gKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCd3YWxrcyBpbnRvIGEgcGxhdGUgYW5kIHNheXMgc28nLCAoKSA9PiB7XG4gICAgY29uc3Qgbm90ZSA9IHJlc3VsdC5ub3Rlcy5maW5kKChlbnRyeSkgPT4gZW50cnkucGF0aC5lbmRzV2l0aCgncGxhdGUub21lLnphcnInKSk7XG4gICAgYXNzZXJ0Lm9rKG5vdGUsICdleHBlY3RlZCBhIG5vdGUgYWJvdXQgdGhlIHBsYXRlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGUua2luZCwgJ3NraXBwZWQnKTtcbiAgICBhc3NlcnQubWF0Y2gobm90ZS5tZXNzYWdlLCAvcGxhdGUvaSk7XG4gIH0pO1xuXG4gIGl0KCdpZ25vcmVzIGEgYmFyZSBhcnJheSB3aXRob3V0IHJlcG9ydGluZyBpdCBiZWxvdyB0aGUgZHJvcCByb290JywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdC5kYXRhc2V0cy5zb21lKChkYXRhc2V0KSA9PiBkYXRhc2V0LnJlbGF0aXZlUGF0aC5pbmNsdWRlcygnYmFyZS1hcnJheScpKSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0Lm5vdGVzLnNvbWUoKG5vdGUpID0+IG5vdGUucGF0aC5pbmNsdWRlcygnYmFyZS1hcnJheScpKSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCd0cmVhdHMgYSBkcm9wcGVkIGRhdGFzZXQgcm9vdCBhcyBhIHNpbmdsZSBkYXRhc2V0JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNpbmdsZSA9IGF3YWl0IGRpc2NvdmVySW5Nb3VudChcbiAgICAgIG1vdW50Rm9yKGpvaW4oZml4dHVyZS5yb290LCAndjItaW1hZ2Uub21lLnphcnInKSwgJ3YyLWltYWdlLm9tZS56YXJyJyksXG4gICAgICB7IHVybEJ1aWxkZXIgfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChzaW5nbGUuZGF0YXNldHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoc2luZ2xlLmRhdGFzZXRzWzBdLnJlbGF0aXZlUGF0aCwgJycpO1xuICAgIGFzc2VydC5lcXVhbChzaW5nbGUuZGF0YXNldHNbMF0ubmFtZSwgJ3YyLWltYWdlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNpbmdsZS5kYXRhc2V0c1swXS52aXJ0dWFsVXJsLCAnaHR0cHM6Ly9leGFtcGxlLnRlc3QvX2xvY2FsL20xLycpO1xuICB9KTtcblxuICBpdCgncmVwb3J0cyBhIGRyb3BwZWQgYmFyZSBhcnJheSBhcyB1bnN1cHBvcnRlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzaW5nbGUgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQoXG4gICAgICBtb3VudEZvcihqb2luKGZpeHR1cmUucm9vdCwgJ2JhcmUtYXJyYXkuemFycicpLCAnYmFyZS1hcnJheS56YXJyJyksXG4gICAgICB7IHVybEJ1aWxkZXIgfSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChzaW5nbGUuZGF0YXNldHMubGVuZ3RoLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwoc2luZ2xlLm5vdGVzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNpbmdsZS5ub3Rlc1swXS5raW5kLCAndW5zdXBwb3J0ZWQnKTtcbiAgICBhc3NlcnQubWF0Y2goc2luZ2xlLm5vdGVzWzBdLm1lc3NhZ2UsIC9iYXJlIFphcnIgYXJyYXkvKTtcbiAgfSk7XG5cbiAgaXQoJ2hvbm91cnMgdGhlIGRhdGFzZXQgbGltaXQgYW5kIHJlcG9ydHMgaXQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgbGltaXRlZCA9IGF3YWl0IGRpc2NvdmVySW5Nb3VudChtb3VudEZvcihmaXh0dXJlLnJvb3QsICdkcm9wJyksIHtcbiAgICAgIHVybEJ1aWxkZXIsXG4gICAgICBsaW1pdHM6IHsgbWF4RGF0YXNldHM6IDEgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwobGltaXRlZC5kYXRhc2V0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5vayhsaW1pdGVkLm5vdGVzLnNvbWUoKG5vdGUpID0+IG5vdGUua2luZCA9PT0gJ2xpbWl0JykpO1xuICB9KTtcblxuICBpdCgnc3RvcHMgYXQgdGhlIGRlcHRoIGxpbWl0IHJhdGhlciB0aGFuIHdhbGtpbmcgZm9yZXZlcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzaGFsbG93ID0gYXdhaXQgZGlzY292ZXJJbk1vdW50KG1vdW50Rm9yKGZpeHR1cmUucm9vdCwgJ2Ryb3AnKSwge1xuICAgICAgdXJsQnVpbGRlcixcbiAgICAgIGxpbWl0czogeyBtYXhEZXB0aDogMSB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBzaGFsbG93LmRhdGFzZXRzLm1hcCgoZGF0YXNldCkgPT4gZGF0YXNldC5yZWxhdGl2ZVBhdGgpLFxuICAgICAgWyd2Mi1pbWFnZS5vbWUuemFyciddLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKHNoYWxsb3cubm90ZXMuc29tZSgobm90ZSkgPT4gbm90ZS5raW5kID09PSAnbGltaXQnKSk7XG4gIH0pO1xuXG4gIGl0KCdyZXBvcnRzIHByb2dyZXNzIGFzIGl0IHdhbGtzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlZW46IG51bWJlcltdID0gW107XG4gICAgYXdhaXQgZGlzY292ZXJJbk1vdW50KG1vdW50Rm9yKGZpeHR1cmUucm9vdCwgJ2Ryb3AnKSwge1xuICAgICAgdXJsQnVpbGRlcixcbiAgICAgIG9uUHJvZ3Jlc3M6IChwcm9ncmVzcykgPT4gc2Vlbi5wdXNoKHByb2dyZXNzLmRpcmVjdG9yaWVzU2Nhbm5lZCksXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHNlZW4ubGVuZ3RoID4gMSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChzZWVuLCBbLi4uc2Vlbl0uc29ydCgoYSwgYikgPT4gYSAtIGIpKTtcbiAgfSk7XG59KTtcbiIsICIvKipcbiAqIENvbnRyYWN0IHNoYXJlZCBieSB0aGUgcGFnZSBhbmQgdGhlIHNlcnZpY2Ugd29ya2VyLlxuICpcbiAqIEJvdGggc2lkZXMgcnVuIGluIHRoZSBzYW1lIG9yaWdpbiBidXQgaW4gZGlmZmVyZW50IEpTIHJlYWxtcywgc28gZXZlcnl0aGluZ1xuICogdGhleSBhZ3JlZSBvbiBcdTIwMTQgSW5kZXhlZERCIG5hbWVzLCBVUkwgcHJlZml4ZXMsIG1lc3NhZ2Ugc2hhcGVzIFx1MjAxNCBsaXZlcyBoZXJlLlxuICovXG5cbi8qKlxuICogVmlydHVhbCBuYW1lc3BhY2Ugc2VnbWVudHMsIGFwcGVuZGVkIHRvIHRoZSBkZXBsb3ltZW50IGJhc2UgcGF0aC5cbiAqXG4gKiBUaGUgYmFzZSBpcyBub3QgYSBjb25zdGFudDogdGhlIHBvcnRhbCBpcyBidWlsdCB3aXRoIGEgcmVsYXRpdmUgYmFzZSBzbyB0aGVcbiAqIHNhbWUgYnVuZGxlIHJ1bnMgYXQgYW4gb3JpZ2luIHJvb3QgYW5kIGF0IGEgR2l0SHViIFBhZ2VzIHByb2plY3Qgc3VicGF0aFxuICogKGAvPHJlcG8+L2ApLiBBIHNlcnZpY2Ugd29ya2VyIGNhbiBvbmx5IGNsYWltIGEgc2NvcGUgYXQgb3IgYmVsb3cgaXRzIG93blxuICogcGF0aCwgc28gYXQgYC88cmVwbz4vYCB0aGUgbmFtZXNwYWNlIGlzIGAvPHJlcG8+L19sb2NhbC8uLi5gLiBCb3RoIHNpZGVzXG4gKiBkZXJpdmUgdGhlIGJhc2UgYXQgcnVudGltZSBcdTIwMTQgdGhlIHdvcmtlciBmcm9tIGl0cyByZWdpc3RyYXRpb24gc2NvcGUsIHRoZVxuICogcGFnZSBmcm9tIHRoZSBzYW1lIHNjb3BlIG9uY2UgcmVnaXN0ZXJlZCBcdTIwMTQgYW5kIGpvaW4gdGhlc2Ugc2VnbWVudHMgb250byBpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IExPQ0FMX1NFR01FTlQgPSAnX2xvY2FsJztcbmV4cG9ydCBjb25zdCBTRVNTSU9OX1NFR01FTlQgPSAnX3Nlc3Npb24nO1xuXG4vKiogSm9pbiBhIGJhc2UgcGF0aCAod2l0aCB0cmFpbGluZyBzbGFzaCkgYW5kIGEgbmFtZXNwYWNlIHNlZ21lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gbmFtZXNwYWNlUHJlZml4KGJhc2VQYXRoOiBzdHJpbmcsIHNlZ21lbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtiYXNlUGF0aH0ke3NlZ21lbnR9L2A7XG59XG5cbmV4cG9ydCBjb25zdCBEQl9OQU1FID0gJ29tZS16YXJyLXBvcnRhbCc7XG5leHBvcnQgY29uc3QgREJfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgTU9VTlRfU1RPUkUgPSAnbW91bnRzJztcbmV4cG9ydCBjb25zdCBTRVNTSU9OX1NUT1JFID0gJ3Nlc3Npb25GaWxlcyc7XG5cbi8qKlxuICogQSBtb3VudGVkIGxvY2FsIGRpcmVjdG9yeS5cbiAqXG4gKiBgaGFuZGxlYCBpcyBhIGxpdmUgYEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVgLiBCb3RoIEluZGV4ZWREQiBhbmRcbiAqIGBwb3N0TWVzc2FnZWAgY2FuIGNhcnJ5IHRoZXNlIGJ5IHN0cnVjdHVyZWQgY2xvbmUsIHdoaWNoIGlzIHdoYXQgbGV0cyB0aGVcbiAqIHNlcnZpY2Ugd29ya2VyIHJlYWQgdGhlIHVzZXIncyBmaWxlcyBkaXJlY3RseSBpbnN0ZWFkIG9mIHByb3h5aW5nIGV2ZXJ5XG4gKiBieXRlIHRocm91Z2ggdGhlIHBhZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTW91bnRSZWNvcmQge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGhhbmRsZTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZTtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG59XG5cbi8qKiBBIGdlbmVyYXRlZCBkb2N1bWVudCBzZXJ2ZWQgdW5kZXIgdGhlIGBfc2Vzc2lvbi9gIG5hbWVzcGFjZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbkZpbGVSZWNvcmQge1xuICAvKiogYCR7c2Vzc2lvbklkfS8ke3BhdGh9YCBcdTIwMTQgdGhlIEluZGV4ZWREQiBrZXkuICovXG4gIGtleTogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcGF0aDogc3RyaW5nO1xuICBib2R5OiBzdHJpbmc7XG4gIGNvbnRlbnRUeXBlOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xufVxuXG4vKiogTWVzc2FnZXMgdGhlIHBhZ2Ugc2VuZHMgdG8gdGhlIHNlcnZpY2Ugd29ya2VyLiAqL1xuZXhwb3J0IHR5cGUgUG9ydGFsTWVzc2FnZSA9XG4gIHwgeyB0eXBlOiAncGluZycgfVxuICB8IHsgdHlwZTogJ2ZsdXNoJzsgbW91bnRJZD86IHN0cmluZyB9O1xuXG4vKiogQnVtcGVkIHdoZW4gdGhlIHdvcmtlcidzIGJlaGF2aW91ciBjaGFuZ2VzLCBmb3IgZGVidWdnaW5nLiAqL1xuZXhwb3J0IGNvbnN0IFNXX1ZFUlNJT04gPSAnMSc7XG4iLCAiLyoqXG4gKiBQYWdlLXNpZGUgaGFsZiBvZiB0aGUgdmlydHVhbCBmaWxlc3lzdGVtOiByZWdpc3RlcnMgdGhlIHNlcnZpY2Ugd29ya2VyIGFuZFxuICogd3JpdGVzIHRoZSByZWNvcmRzIGl0IHJlYWRzLlxuICovXG5pbXBvcnQgeyBpZGJEZWxldGUsIGlkYkdldEFsbCwgaWRiUHV0IH0gZnJvbSAnLi9pZGInO1xuaW1wb3J0IHtcbiAgTE9DQUxfU0VHTUVOVCxcbiAgbmFtZXNwYWNlUHJlZml4LFxuICBTRVNTSU9OX1NFR01FTlQsXG4gIFNFU1NJT05fU1RPUkUsXG4gIHR5cGUgUG9ydGFsTWVzc2FnZSxcbiAgdHlwZSBTZXNzaW9uRmlsZVJlY29yZCxcbn0gZnJvbSAnLi9wcm90b2NvbCc7XG5cbmV4cG9ydCBjbGFzcyBTZXJ2aWNlV29ya2VyVW5hdmFpbGFibGVFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbmxldCByZWdpc3RyYXRpb246IFByb21pc2U8U2VydmljZVdvcmtlclJlZ2lzdHJhdGlvbj4gfCBudWxsID0gbnVsbDtcbmxldCBiYXNlUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogVGhlIHBhdGggdGhlIHBvcnRhbCBpcyBkZXBsb3llZCB1bmRlciwgYWx3YXlzIHdpdGggYSB0cmFpbGluZyBzbGFzaCBcdTIwMTQgYC9gXG4gKiBsb2NhbGx5LCBgLzxyZXBvPi9gIG9uIGEgR2l0SHViIFBhZ2VzIHByb2plY3Qgc2l0ZS5cbiAqXG4gKiBPbmNlIHRoZSB3b3JrZXIgaXMgcmVnaXN0ZXJlZCB0aGlzIGlzIGl0cyBzY29wZSwgd2hpY2ggaXMgYXV0aG9yaXRhdGl2ZTpcbiAqIFVSTHMgYnVpbHQgZnJvbSBhbnkgb3RoZXIgdmFsdWUgd291bGQgbm90IGJlIGludGVyY2VwdGVkLiBCZWZvcmUgdGhhdCwgZmFsbFxuICogYmFjayB0byB0aGUgbGFuZGluZyBwYWdlJ3Mgb3duIGRpcmVjdG9yeSwgd2hpY2ggaXMgdGhlIHNhbWUgdGhpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRCYXNlUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gYmFzZVBhdGggPz8gbmV3IFVSTCgnLi8nLCBsb2NhdGlvbi5ocmVmKS5wYXRobmFtZTtcbn1cblxuLyoqXG4gKiBSZWdpc3RlciB0aGUgd29ya2VyIGFuZCByZXNvbHZlIG9uY2UgaXQgYWN0dWFsbHkgY29udHJvbHMgdGhpcyBwYWdlLlxuICpcbiAqIENvbnRyb2xsaW5nIG1hdHRlcnM6IGFuIHVuY29udHJvbGxlZCBwYWdlJ3MgYC9fbG9jYWwvYCByZXF1ZXN0cyB3b3VsZCBmYWxsXG4gKiB0aHJvdWdoIHRvIHRoZSBuZXR3b3JrIGFuZCA0MDQuIFRoZSB3b3JrZXIgY2FsbHMgYGNsaWVudHMuY2xhaW0oKWAgb25cbiAqIGFjdGl2YXRpb24sIHNvIGEgZmlyc3QtdmlzaXQgcGFnZSBiZWNvbWVzIGNvbnRyb2xsZWQgd2l0aG91dCBhIHJlbG9hZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVNlcnZpY2VXb3JrZXIoKTogUHJvbWlzZTxTZXJ2aWNlV29ya2VyUmVnaXN0cmF0aW9uPiB7XG4gIGlmIChyZWdpc3RyYXRpb24pIHJldHVybiByZWdpc3RyYXRpb247XG5cbiAgcmVnaXN0cmF0aW9uID0gKGFzeW5jICgpID0+IHtcbiAgICBpZiAoISgnc2VydmljZVdvcmtlcicgaW4gbmF2aWdhdG9yKSkge1xuICAgICAgdGhyb3cgbmV3IFNlcnZpY2VXb3JrZXJVbmF2YWlsYWJsZUVycm9yKFxuICAgICAgICAnVGhpcyBicm93c2VyIGhhcyBubyBTZXJ2aWNlIFdvcmtlciBzdXBwb3J0LCB3aGljaCB0aGUgcG9ydGFsIG5lZWRzIHRvIGV4cG9zZSBsb2NhbCBmaWxlcy4nLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCF3aW5kb3cuaXNTZWN1cmVDb250ZXh0KSB7XG4gICAgICB0aHJvdyBuZXcgU2VydmljZVdvcmtlclVuYXZhaWxhYmxlRXJyb3IoXG4gICAgICAgICdTZXJ2aWNlIFdvcmtlcnMgcmVxdWlyZSBhIHNlY3VyZSBjb250ZXh0LiBVc2UgaHR0cDovL2xvY2FsaG9zdCBvciBhbiBodHRwczovLyBvcmlnaW4uJyxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gUmVnaXN0ZXJlZCByZWxhdGl2ZSB0byB0aGlzIHBhZ2UsIHdoaWNoIGxpdmVzIGF0IHRoZSBkZXBsb3ltZW50IHJvb3QuXG4gICAgLy8gVGhhdCByZXNvbHZlcyB0byBgL3N3LmpzYCBsb2NhbGx5IGFuZCBgLzxyZXBvPi9zdy5qc2Agb24gR2l0SHViIFBhZ2VzLFxuICAgIC8vIGFuZCB0aGUgZGVmYXVsdCBzY29wZSBpcyB0aGUgd29ya2VyJ3Mgb3duIGRpcmVjdG9yeSBpbiBib3RoIGNhc2VzIFx1MjAxNCBzb1xuICAgIC8vIG5vIGJ1aWxkLXRpbWUga25vd2xlZGdlIG9mIHRoZSBkZXBsb3ltZW50IHBhdGggaXMgbmVlZGVkLiBJbiBkZXYsIGEgVml0ZVxuICAgIC8vIG1pZGRsZXdhcmUgc2VydmVzIHRoZSB0cmFuc2Zvcm1lZCB3b3JrZXIgYXQgdGhlIHNhbWUgVVJMLlxuICAgIGNvbnN0IHJlZyA9IGF3YWl0IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKFxuICAgICAgbmV3IFVSTCgnLi9zdy5qcycsIG5ldyBVUkwoJy4vJywgbG9jYXRpb24uaHJlZikpLFxuICAgICAgeyB0eXBlOiAnbW9kdWxlJyB9LFxuICAgICk7XG4gICAgYmFzZVBhdGggPSBuZXcgVVJMKHJlZy5zY29wZSkucGF0aG5hbWU7XG4gICAgYXdhaXQgbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIucmVhZHk7XG5cbiAgICBpZiAoIW5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLmNvbnRyb2xsZXIpIHtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChyZXNvbHZlLCAzMDAwKTtcbiAgICAgICAgbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIuYWRkRXZlbnRMaXN0ZW5lcihcbiAgICAgICAgICAnY29udHJvbGxlcmNoYW5nZScsXG4gICAgICAgICAgKCkgPT4ge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgb25jZTogdHJ1ZSB9LFxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiByZWc7XG4gIH0pKCk7XG5cbiAgcmVnaXN0cmF0aW9uLmNhdGNoKCgpID0+IHtcbiAgICAvLyBBbGxvdyBhIGxhdGVyIHJldHJ5IHJhdGhlciB0aGFuIGNhY2hpbmcgdGhlIGZhaWx1cmUgZm9yZXZlci5cbiAgICByZWdpc3RyYXRpb24gPSBudWxsO1xuICB9KTtcblxuICByZXR1cm4gcmVnaXN0cmF0aW9uO1xufVxuXG4vKiogVGVsbCB0aGUgd29ya2VyIHRvIGZvcmdldCBjYWNoZWQgaGFuZGxlcyBmb3IgYSBtb3VudCAob3IgYWxsIG9mIHRoZW0pLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZsdXNoV29ya2VyKG1vdW50SWQ/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY29udHJvbGxlciA9IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyPy5jb250cm9sbGVyO1xuICBpZiAoIWNvbnRyb2xsZXIpIHJldHVybjtcbiAgY29uc3QgbWVzc2FnZTogUG9ydGFsTWVzc2FnZSA9IHsgdHlwZTogJ2ZsdXNoJywgbW91bnRJZCB9O1xuICBjb250cm9sbGVyLnBvc3RNZXNzYWdlKG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBlbmNvZGVQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLnNwbGl0KCcvJykuZmlsdGVyKEJvb2xlYW4pLm1hcChlbmNvZGVVUklDb21wb25lbnQpLmpvaW4oJy8nKTtcbn1cblxuLyoqXG4gKiBBYnNvbHV0ZSBVUkwgZm9yIGEgcGF0aCBpbnNpZGUgYSBtb3VudCwgZS5nLlxuICogYGh0dHBzOi8vaG9zdC9fbG9jYWwvYWIxMi9zYW1wbGUub21lLnphcnIvMC9jLzAvMC8wYC5cbiAqXG4gKiBTZWdtZW50cyBhcmUgZW5jb2RlZCBpbmRpdmlkdWFsbHkgc28gdGhhdCBzcGFjZXMgYW5kIG90aGVyIGNoYXJhY3RlcnMgdGhhdFxuICogYXJlIGxlZ2FsIGluIGZpbGUgbmFtZXMgc3Vydml2ZSB0aGUgcm91bmQgdHJpcCwgd2hpbGUgYC9gIGtlZXBzIGl0cyBtZWFuaW5nXG4gKiBhcyBhIHNlcGFyYXRvci4gV2l0aCBubyByZWxhdGl2ZSBwYXRoIHRoaXMgcmV0dXJucyB0aGUgbW91bnQgcm9vdCwgd2l0aCBhXG4gKiB0cmFpbGluZyBzbGFzaCBcdTIwMTQgdGhlIGZvcm0gWmFyciBzb3VyY2VzIGV4cGVjdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsVXJsKG1vdW50SWQ6IHN0cmluZywgcmVsYXRpdmVQYXRoID0gJycpOiBzdHJpbmcge1xuICBjb25zdCBwcmVmaXggPSBuYW1lc3BhY2VQcmVmaXgoZ2V0QmFzZVBhdGgoKSwgTE9DQUxfU0VHTUVOVCk7XG4gIHJldHVybiBuZXcgVVJMKFxuICAgIGAke3ByZWZpeH0ke2VuY29kZVVSSUNvbXBvbmVudChtb3VudElkKX0vJHtlbmNvZGVQYXRoKHJlbGF0aXZlUGF0aCl9YCxcbiAgICBsb2NhdGlvbi5vcmlnaW4sXG4gICkuaHJlZjtcbn1cblxuLyoqIEFic29sdXRlIFVSTCBmb3IgYSBwb3J0YWwtZ2VuZXJhdGVkIGRvY3VtZW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlc3Npb25Vcmwoc2Vzc2lvbklkOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHByZWZpeCA9IG5hbWVzcGFjZVByZWZpeChnZXRCYXNlUGF0aCgpLCBTRVNTSU9OX1NFR01FTlQpO1xuICByZXR1cm4gbmV3IFVSTChcbiAgICBgJHtwcmVmaXh9JHtlbmNvZGVVUklDb21wb25lbnQoc2Vzc2lvbklkKX0vJHtlbmNvZGVQYXRoKHBhdGgpfWAsXG4gICAgbG9jYXRpb24ub3JpZ2luLFxuICApLmhyZWY7XG59XG5cbi8qKiBBYnNvbHV0ZSBVUkwgZm9yIGEgcGFnZSBzaGlwcGVkIGFsb25nc2lkZSB0aGUgcG9ydGFsLCBlLmcuIGB6YXJyY2FkZS9gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpdGVVcmwocmVsYXRpdmVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmV3IFVSTChgJHtnZXRCYXNlUGF0aCgpfSR7cmVsYXRpdmVQYXRofWAsIGxvY2F0aW9uLm9yaWdpbikuaHJlZjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHB1dFNlc3Npb25GaWxlKFxuICBzZXNzaW9uSWQ6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcsXG4gIGNvbnRlbnRUeXBlOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZWNvcmQ6IFNlc3Npb25GaWxlUmVjb3JkID0ge1xuICAgIGtleTogYCR7c2Vzc2lvbklkfS8ke3BhdGh9YCxcbiAgICBzZXNzaW9uSWQsXG4gICAgcGF0aCxcbiAgICBib2R5LFxuICAgIGNvbnRlbnRUeXBlLFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgYXdhaXQgaWRiUHV0KFNFU1NJT05fU1RPUkUsIHJlY29yZCk7XG4gIHJldHVybiBzZXNzaW9uVXJsKHNlc3Npb25JZCwgcGF0aCk7XG59XG5cbi8qKlxuICogRHJvcCBnZW5lcmF0ZWQgZG9jdW1lbnRzIGZyb20gb2xkZXIgc2Vzc2lvbnMuXG4gKlxuICogVGhleSBhcmUgdGlueSwgYnV0IHRoZXkgcmVmZXJlbmNlIG1vdW50cyB0aGF0IG1heSBiZSBnb25lLCBzbyBrZWVwaW5nIHRoZW1cbiAqIGFyb3VuZCBvbmx5IGNyZWF0ZXMgY29uZnVzaW5nIGRlYWQgbGlua3MgaW4gdGhlIGJyb3dzZXIgaGlzdG9yeS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBydW5lU2Vzc2lvbnMoa2VlcFNlc3Npb25JZD86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGwgPSBhd2FpdCBpZGJHZXRBbGw8U2Vzc2lvbkZpbGVSZWNvcmQ+KFNFU1NJT05fU1RPUkUpO1xuICBhd2FpdCBQcm9taXNlLmFsbChcbiAgICBhbGxcbiAgICAgIC5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLnNlc3Npb25JZCAhPT0ga2VlcFNlc3Npb25JZClcbiAgICAgIC5tYXAoKHJlY29yZCkgPT4gaWRiRGVsZXRlKFNFU1NJT05fU1RPUkUsIHJlY29yZC5rZXkpKSxcbiAgKTtcbn1cbiIsICIvKipcbiAqIFJlYWRpbmcgYW5kIGludGVycHJldGluZyBaYXJyIC8gT01FLU5HRkYgbWV0YWRhdGEgZnJvbSBhIGRpcmVjdG9yeSBoYW5kbGUuXG4gKlxuICogS2VwdCBzZXBhcmF0ZSBmcm9tIHRoZSB0cmF2ZXJzYWwgc28gdGhlIHJ1bGVzIGFib3V0IFwid2hhdCBjb3VudHMgYXMgYVxuICogZGF0YXNldFwiIGFyZSBpbiBvbmUgcmVhZGFibGUgcGxhY2UuIEhhbmRsZXMgYm90aCBsYXlvdXRzIGluIGN1cnJlbnQgdXNlOlxuICpcbiAqICAgWmFyciB2MiAoT01FLU5HRkYgPD0gMC40KTogYC56Z3JvdXBgIC8gYC56YXJyYXlgIC8gYC56YXR0cnNgLCB3aXRoXG4gKiAgICAgYG11bHRpc2NhbGVzYCBhdCB0aGUgdG9wIGxldmVsIG9mIGAuemF0dHJzYC5cbiAqICAgWmFyciB2MyAoT01FLU5HRkYgPj0gMC41KTogYSBzaW5nbGUgYHphcnIuanNvbmAgd2hvc2UgYG5vZGVfdHlwZWAgc2F5c1xuICogICAgIGdyb3VwIG9yIGFycmF5LCB3aXRoIGBtdWx0aXNjYWxlc2AgbmVzdGVkIHVuZGVyIGBhdHRyaWJ1dGVzLm9tZWAuXG4gKi9cblxuZXhwb3J0IHR5cGUgSnNvbk9iamVjdCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG5leHBvcnQgdHlwZSBaYXJyTm9kZSA9XG4gIHwgeyBraW5kOiAnYXJyYXknOyBmb3JtYXQ6IDIgfCAzIH1cbiAgfCB7IGtpbmQ6ICdncm91cCc7IGZvcm1hdDogMiB8IDM7IGF0dHJpYnV0ZXM6IEpzb25PYmplY3QgfVxuICAvKiogTm8gWmFyciBtZXRhZGF0YSBoZXJlOiBhbiBvcmRpbmFyeSBkaXJlY3RvcnkuICovXG4gIHwgeyBraW5kOiAnbm9uZScgfTtcblxuZXhwb3J0IGNsYXNzIE1ldGFkYXRhRXJyb3IgZXh0ZW5kcyBFcnJvciB7fVxuXG5mdW5jdGlvbiBpc09iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIEpzb25PYmplY3Qge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKlxuICogUmVhZCBhbmQgcGFyc2UgYSBKU09OIGZpbGUsIHJldHVybmluZyB1bmRlZmluZWQgd2hlbiBpdCBkb2VzIG5vdCBleGlzdC5cbiAqXG4gKiBBIG1pc3NpbmcgZmlsZSBpcyB0aGUgbm9ybWFsIHdheSB0byBwcm9iZSBmb3IgYSBsYXlvdXQsIGJ1dCBhIGZpbGUgdGhhdFxuICogZXhpc3RzIGFuZCBkb2VzIG5vdCBwYXJzZSBpcyBhIHJlYWwgcHJvYmxlbSB3b3J0aCBzdXJmYWNpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkSnNvbkZpbGUoXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgbmFtZTogc3RyaW5nLFxuKTogUHJvbWlzZTxKc29uT2JqZWN0IHwgdW5kZWZpbmVkPiB7XG4gIGxldCBmaWxlOiBGaWxlO1xuICB0cnkge1xuICAgIGNvbnN0IGhhbmRsZSA9IGF3YWl0IGRpcmVjdG9yeS5nZXRGaWxlSGFuZGxlKG5hbWUpO1xuICAgIGZpbGUgPSBhd2FpdCBoYW5kbGUuZ2V0RmlsZSgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiAoZXJyb3IubmFtZSA9PT0gJ05vdEZvdW5kRXJyb3InIHx8IGVycm9yLm5hbWUgPT09ICdUeXBlTWlzbWF0Y2hFcnJvcicpKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGNvbnN0IHRleHQgPSBhd2FpdCBmaWxlLnRleHQoKTtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IG5ldyBNZXRhZGF0YUVycm9yKGAke25hbWV9IGlzIG5vdCB2YWxpZCBKU09OOiAkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuICBpZiAoIWlzT2JqZWN0KHBhcnNlZCkpIHtcbiAgICB0aHJvdyBuZXcgTWV0YWRhdGFFcnJvcihgJHtuYW1lfSBkb2VzIG5vdCBjb250YWluIGEgSlNPTiBvYmplY3RgKTtcbiAgfVxuICByZXR1cm4gcGFyc2VkO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgZGlyZWN0b3J5IGFzIGEgWmFyciBhcnJheSwgYSBaYXJyIGdyb3VwLCBvciBuZWl0aGVyLlxuICpcbiAqIFByb2JpbmcgYnkgbmFtZSBpcyBkZWxpYmVyYXRlOiBpdCBjb3N0cyBhdCBtb3N0IHRocmVlIGZhaWxlZCBsb29rdXBzIHBlclxuICogZGlyZWN0b3J5IGFuZCBuZXZlciBlbnVtZXJhdGVzIGVudHJpZXMsIHdoaWNoIG1hdHRlcnMgYmVjYXVzZSBhbiBhcnJheSdzXG4gKiBjaHVuayBkaXJlY3RvcnkgY2FuIGhvbGQgbWlsbGlvbnMgb2YgZmlsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkWmFyck5vZGUoZGlyZWN0b3J5OiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlKTogUHJvbWlzZTxaYXJyTm9kZT4ge1xuICBjb25zdCB2MyA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICd6YXJyLmpzb24nKTtcbiAgaWYgKHYzKSB7XG4gICAgLy8gYG5vZGVfdHlwZWAgaXMgcmVxdWlyZWQgaW4gWmFyciB2MzsgZGVmYXVsdCB0byBncm91cCBmb3IgdG9sZXJhbmNlLlxuICAgIGNvbnN0IG5vZGVUeXBlID0gdHlwZW9mIHYzLm5vZGVfdHlwZSA9PT0gJ3N0cmluZycgPyB2My5ub2RlX3R5cGUgOiAnZ3JvdXAnO1xuICAgIGlmIChub2RlVHlwZSA9PT0gJ2FycmF5JykgcmV0dXJuIHsga2luZDogJ2FycmF5JywgZm9ybWF0OiAzIH07XG4gICAgY29uc3QgYXR0cmlidXRlcyA9IGlzT2JqZWN0KHYzLmF0dHJpYnV0ZXMpID8gdjMuYXR0cmlidXRlcyA6IHt9O1xuICAgIHJldHVybiB7IGtpbmQ6ICdncm91cCcsIGZvcm1hdDogMywgYXR0cmlidXRlcyB9O1xuICB9XG5cbiAgaWYgKGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemFycmF5JykpIHtcbiAgICByZXR1cm4geyBraW5kOiAnYXJyYXknLCBmb3JtYXQ6IDIgfTtcbiAgfVxuXG4gIGNvbnN0IHpncm91cCA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemdyb3VwJyk7XG4gIGNvbnN0IHphdHRycyA9IGF3YWl0IHJlYWRKc29uRmlsZShkaXJlY3RvcnksICcuemF0dHJzJyk7XG4gIGlmICh6Z3JvdXAgfHwgemF0dHJzKSB7XG4gICAgcmV0dXJuIHsga2luZDogJ2dyb3VwJywgZm9ybWF0OiAyLCBhdHRyaWJ1dGVzOiB6YXR0cnMgPz8ge30gfTtcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQ6ICdub25lJyB9O1xufVxuXG4vKipcbiAqIFRoZSBhdHRyaWJ1dGUgYmFnIE9NRSBtZXRhZGF0YSBsaXZlcyBpbi5cbiAqXG4gKiBOR0ZGIDAuNSBuZXN0cyBldmVyeXRoaW5nIHVuZGVyIGFuIGBvbWVgIGtleTsgMC40IGFuZCBlYXJsaWVyIHB1dCBpdCBhdCB0aGVcbiAqIHRvcCBsZXZlbCBvZiBgLnphdHRyc2AuIFNvbWUgd3JpdGVycyBlbWl0IHRoZSAwLjQgc2hhcGUgaW5zaWRlIGEgdjNcbiAqIGB6YXJyLmpzb25gLCBzbyBib3RoIGFyZSBjaGVja2VkIHJlZ2FyZGxlc3Mgb2YgWmFyciB2ZXJzaW9uLlxuICovXG5mdW5jdGlvbiBvbWVBdHRyaWJ1dGVzKG5vZGU6IHsgYXR0cmlidXRlczogSnNvbk9iamVjdCB9KTogSnNvbk9iamVjdFtdIHtcbiAgY29uc3QgYmFnczogSnNvbk9iamVjdFtdID0gW107XG4gIGlmIChpc09iamVjdChub2RlLmF0dHJpYnV0ZXMub21lKSkgYmFncy5wdXNoKG5vZGUuYXR0cmlidXRlcy5vbWUpO1xuICBiYWdzLnB1c2gobm9kZS5hdHRyaWJ1dGVzKTtcbiAgcmV0dXJuIGJhZ3M7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTXVsdGlzY2FsZUluZm8ge1xuICAvKiogVmVyc2lvbiBkZWNsYXJlZCBieSB0aGUgbWV0YWRhdGEsIGlmIGFueS4gKi9cbiAgdmVyc2lvbj86IHN0cmluZztcbiAgLyoqIEF4aXMgbmFtZXMgaW4gb3JkZXIsIHdoZW4gdGhlIG1ldGFkYXRhIGRlY2xhcmVzIGF4ZXMgKE5HRkYgPj0gMC4zKS4gKi9cbiAgYXhlcz86IHN0cmluZ1tdO1xuICAvKiogUmVsYXRpdmUgYXJyYXkgcGF0aHMsIGNvYXJzZXN0IGxhc3QuICovXG4gIHBhdGhzOiBzdHJpbmdbXTtcbiAgbmFtZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBFeHRyYWN0IG11bHRpc2NhbGUgaW5mb3JtYXRpb24sIG9yIG51bGwgaWYgdGhpcyBncm91cCBpcyBub3QgYSBtdWx0aXNjYWxlXG4gKiBpbWFnZS4gUHJlc2VuY2Ugb2YgYG11bHRpc2NhbGVzYCBpcyB3aGF0IG1ha2VzIGEgZ3JvdXAgYSBkYXRhc2V0IHJvb3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkTXVsdGlzY2FsZShub2RlOiB7IGF0dHJpYnV0ZXM6IEpzb25PYmplY3QgfSk6IE11bHRpc2NhbGVJbmZvIHwgbnVsbCB7XG4gIGZvciAoY29uc3QgYmFnIG9mIG9tZUF0dHJpYnV0ZXMobm9kZSkpIHtcbiAgICBjb25zdCBtdWx0aXNjYWxlcyA9IGJhZy5tdWx0aXNjYWxlcztcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobXVsdGlzY2FsZXMpIHx8IG11bHRpc2NhbGVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cbiAgICBjb25zdCBmaXJzdCA9IG11bHRpc2NhbGVzWzBdO1xuICAgIGlmICghaXNPYmplY3QoZmlyc3QpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGZpcnN0LmRhdGFzZXRzKSkge1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBmaXJzdC5kYXRhc2V0cykge1xuICAgICAgICBpZiAoaXNPYmplY3QoZW50cnkpICYmIHR5cGVvZiBlbnRyeS5wYXRoID09PSAnc3RyaW5nJykgcGF0aHMucHVzaChlbnRyeS5wYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgYXhlczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZmlyc3QuYXhlcykpIHtcbiAgICAgIGNvbnN0IG5hbWVzID0gZmlyc3QuYXhlcy5tYXAoKGF4aXMpID0+XG4gICAgICAgIC8vIE5HRkYgPj0gMC40IHVzZXMgb2JqZWN0czsgMC4zIHVzZWQgYmFyZSBzdHJpbmdzLlxuICAgICAgICB0eXBlb2YgYXhpcyA9PT0gJ3N0cmluZycgPyBheGlzIDogaXNPYmplY3QoYXhpcykgJiYgdHlwZW9mIGF4aXMubmFtZSA9PT0gJ3N0cmluZycgPyBheGlzLm5hbWUgOiAnPycsXG4gICAgICApO1xuICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDApIGF4ZXMgPSBuYW1lcztcbiAgICB9XG5cbiAgICAvLyBJbiAwLjUgdGhlIHZlcnNpb24gc2l0cyBiZXNpZGUgYG11bHRpc2NhbGVzYCBpbiB0aGUgYG9tZWAgYmFnOyBpblxuICAgIC8vIGVhcmxpZXIgdmVyc2lvbnMgaXQgc2l0cyBpbnNpZGUgZWFjaCBtdWx0aXNjYWxlIGVudHJ5LlxuICAgIGNvbnN0IHZlcnNpb24gPVxuICAgICAgdHlwZW9mIGJhZy52ZXJzaW9uID09PSAnc3RyaW5nJ1xuICAgICAgICA/IGJhZy52ZXJzaW9uXG4gICAgICAgIDogdHlwZW9mIGZpcnN0LnZlcnNpb24gPT09ICdzdHJpbmcnXG4gICAgICAgICAgPyBmaXJzdC52ZXJzaW9uXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICByZXR1cm4ge1xuICAgICAgdmVyc2lvbixcbiAgICAgIGF4ZXMsXG4gICAgICBwYXRocyxcbiAgICAgIG5hbWU6IHR5cGVvZiBmaXJzdC5uYW1lID09PSAnc3RyaW5nJyA/IGZpcnN0Lm5hbWUgOiB1bmRlZmluZWQsXG4gICAgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRydWUgaWYgdGhlIGdyb3VwIGlzIGFuIEhDUyBwbGF0ZSByb290LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUGxhdGUobm9kZTogeyBhdHRyaWJ1dGVzOiBKc29uT2JqZWN0IH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG9tZUF0dHJpYnV0ZXMobm9kZSkuc29tZSgoYmFnKSA9PiBpc09iamVjdChiYWcucGxhdGUpKTtcbn1cblxuLyoqIFRydWUgaWYgdGhlIGdyb3VwIGlzIGEgYGJpb2Zvcm1hdHMycmF3LmxheW91dGAgY29udGFpbmVyIG9mIGltYWdlIHNlcmllcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Jpb2Zvcm1hdHMyUmF3TGF5b3V0KG5vZGU6IHsgYXR0cmlidXRlczogSnNvbk9iamVjdCB9KTogYm9vbGVhbiB7XG4gIHJldHVybiBvbWVBdHRyaWJ1dGVzKG5vZGUpLnNvbWUoKGJhZykgPT4gYmFnWydiaW9mb3JtYXRzMnJhdy5sYXlvdXQnXSAhPT0gdW5kZWZpbmVkKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcnJheUluZm8ge1xuICBzaGFwZT86IG51bWJlcltdO1xuICBkdHlwZT86IHN0cmluZztcbn1cblxuLyoqIFJlYWQgc2hhcGUgYW5kIGR0eXBlIGZyb20gYW4gYXJyYXkncyBvd24gbWV0YWRhdGEsIGZvciBkaXNwbGF5IHB1cnBvc2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRBcnJheUluZm8ocmF3OiBKc29uT2JqZWN0KTogQXJyYXlJbmZvIHtcbiAgY29uc3Qgc2hhcGUgPSBBcnJheS5pc0FycmF5KHJhdy5zaGFwZSkgJiYgcmF3LnNoYXBlLmV2ZXJ5KChuKSA9PiB0eXBlb2YgbiA9PT0gJ251bWJlcicpXG4gICAgPyAocmF3LnNoYXBlIGFzIG51bWJlcltdKVxuICAgIDogdW5kZWZpbmVkO1xuXG4gIC8vIHYzIGNhbGxzIGl0IGBkYXRhX3R5cGVgLCB2MiBgZHR5cGVgICh3aXRoIGEgYnl0ZS1vcmRlciBwcmVmaXggbGlrZSBgPHUyYCkuXG4gIGNvbnN0IGR0eXBlID1cbiAgICB0eXBlb2YgcmF3LmRhdGFfdHlwZSA9PT0gJ3N0cmluZydcbiAgICAgID8gcmF3LmRhdGFfdHlwZVxuICAgICAgOiB0eXBlb2YgcmF3LmR0eXBlID09PSAnc3RyaW5nJ1xuICAgICAgICA/IHJhdy5kdHlwZVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICByZXR1cm4geyBzaGFwZSwgZHR5cGUgfTtcbn1cbiIsICIvKipcbiAqIFR5cGVzIGZvciB0aGUgT01FLVphcnIgZGlzY292ZXJ5IGxheWVyLlxuICovXG5cbi8qKiBBIG11bHRpc2NhbGUgT01FLVphcnIgaW1hZ2UgZm91bmQgaW5zaWRlIGEgbW91bnRlZCBkaXJlY3RvcnkuICovXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvdmVyZWREYXRhc2V0IHtcbiAgLyoqIFN0YWJsZSB3aXRoaW4gYSBzZXNzaW9uOiBgPG1vdW50LWlkPjo8cmVsYXRpdmUtcGF0aD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICAvKiogRGlzcGxheSBuYW1lLCBmcm9tIHRoZSBkaXJlY3RvcnkgbmFtZSB3aXRoIGAub21lLnphcnJgL2AuemFycmAgc3RyaXBwZWQuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFBhdGggcmVsYXRpdmUgdG8gdGhlIG1vdW50IHJvb3Q7IGVtcHR5IHdoZW4gdGhlIG1vdW50IHJvb3QgaXMgaXRzZWxmIGEgZGF0YXNldC4gKi9cbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmc7XG4gIC8qKiBTYW1lLW9yaWdpbiBVUkwgc2VydmVkIGJ5IHRoZSB3b3JrZXIsIGFsd2F5cyB3aXRoIGEgdHJhaWxpbmcgc2xhc2guICovXG4gIHZpcnR1YWxVcmw6IHN0cmluZztcbiAgLyoqIE9NRS1OR0ZGIHZlcnNpb24gc3RyaW5nLCBlLmcuIGAwLjRgIG9yIGAwLjVgLCB3aGVuIHRoZSBtZXRhZGF0YSBkZWNsYXJlcyBvbmUuICovXG4gIG9tZVphcnJWZXJzaW9uPzogc3RyaW5nO1xuXG4gIC8qIC0tLSBjb250ZXh0IGFuZCBiZXN0LWVmZm9ydCBtZXRhZGF0YSwgdXNlZCBieSB0aGUgZ2FsbGVyeSAtLS0gKi9cbiAgbW91bnRJZDogc3RyaW5nO1xuICBtb3VudE5hbWU6IHN0cmluZztcbiAgLyoqIFphcnIgc3BlY2lmaWNhdGlvbiB2ZXJzaW9uIG9mIHRoZSBncm91cDogMiBvciAzLiAqL1xuICB6YXJyRm9ybWF0OiAyIHwgMztcbiAgLyoqIEF4aXMgbmFtZXMgb2YgdGhlIG11bHRpc2NhbGUsIGUuZy4gYFsndCcsJ2MnLCd6JywneScsJ3gnXWAuICovXG4gIGF4ZXM/OiBzdHJpbmdbXTtcbiAgLyoqIFNoYXBlIG9mIHRoZSBoaWdoZXN0LXJlc29sdXRpb24gYXJyYXkuICovXG4gIHNoYXBlPzogbnVtYmVyW107XG4gIC8qKiBEYXRhIHR5cGUgb2YgdGhlIGhpZ2hlc3QtcmVzb2x1dGlvbiBhcnJheSwgZS5nLiBgdWludDE2YC4gKi9cbiAgZHR5cGU/OiBzdHJpbmc7XG4gIC8qKiBOdW1iZXIgb2YgcmVzb2x1dGlvbiBsZXZlbHMuICovXG4gIHNjYWxlQ291bnQ/OiBudW1iZXI7XG59XG5cbmV4cG9ydCB0eXBlIERpc2NvdmVyeU5vdGVLaW5kID1cbiAgLyoqIFNvbWV0aGluZyByZWNvZ25pc2FibGUgdGhhdCB0aGlzIHBvcnRhbCBjYW5ub3Qgb3Blbi4gKi9cbiAgfCAndW5zdXBwb3J0ZWQnXG4gIC8qKiBTb21ldGhpbmcgZGVsaWJlcmF0ZWx5IG5vdCB0cmVhdGVkIGFzIGEgZGF0YXNldC4gKi9cbiAgfCAnc2tpcHBlZCdcbiAgLyoqIE1ldGFkYXRhIHRoYXQgZXhpc3RzIGJ1dCBjb3VsZCBub3QgYmUgcmVhZC4gKi9cbiAgfCAnZXJyb3InXG4gIC8qKiBBIHRyYXZlcnNhbCBsaW1pdCBzdG9wcGVkIHRoZSBzZWFyY2ggZWFybHkuICovXG4gIHwgJ2xpbWl0JztcblxuZXhwb3J0IGludGVyZmFjZSBEaXNjb3ZlcnlOb3RlIHtcbiAga2luZDogRGlzY292ZXJ5Tm90ZUtpbmQ7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBsb2NhdGlvbiwgZS5nLiBgbXktZm9sZGVyL3BsYXRlLm9tZS56YXJyYC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJ5UmVzdWx0IHtcbiAgZGF0YXNldHM6IERpc2NvdmVyZWREYXRhc2V0W107XG4gIG5vdGVzOiBEaXNjb3ZlcnlOb3RlW107XG4gIGRpcmVjdG9yaWVzU2Nhbm5lZDogbnVtYmVyO1xufVxuXG4vKipcbiAqIEJvdW5kcyBvbiB0aGUgd2Fsay4gQSBkcm9wcGVkIGZvbGRlciBjYW4gYmUgYW55dGhpbmcgXHUyMDE0IGEgaG9tZSBkaXJlY3RvcnksIGFcbiAqIHBsYXRlIHdpdGggdGVucyBvZiB0aG91c2FuZHMgb2Ygd2VsbHMgXHUyMDE0IHNvIGV2ZXJ5IGRpbWVuc2lvbiBvZiB0aGUgc2VhcmNoIGlzXG4gKiBjYXBwZWQgYW5kIHRoZSB1c2VyIGlzIHRvbGQgd2hlbiBhIGNhcCB3YXMgaGl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvdmVyeUxpbWl0cyB7XG4gIG1heERlcHRoOiBudW1iZXI7XG4gIG1heERhdGFzZXRzOiBudW1iZXI7XG4gIG1heERpcmVjdG9yaWVzOiBudW1iZXI7XG4gIG1heEVudHJpZXNQZXJEaXJlY3Rvcnk6IG51bWJlcjtcbn1cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfTElNSVRTOiBEaXNjb3ZlcnlMaW1pdHMgPSB7XG4gIG1heERlcHRoOiAxMCxcbiAgbWF4RGF0YXNldHM6IDEwMDAsXG4gIG1heERpcmVjdG9yaWVzOiAyMDAwMCxcbiAgbWF4RW50cmllc1BlckRpcmVjdG9yeTogNTAwMCxcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJ5UHJvZ3Jlc3Mge1xuICBkaXJlY3Rvcmllc1NjYW5uZWQ6IG51bWJlcjtcbiAgZGF0YXNldHNGb3VuZDogbnVtYmVyO1xuICBjdXJyZW50UGF0aDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvdmVyeU9wdGlvbnMge1xuICBsaW1pdHM/OiBQYXJ0aWFsPERpc2NvdmVyeUxpbWl0cz47XG4gIC8qKlxuICAgKiBCdWlsZCB0aGUgdmlydHVhbCBVUkwgZm9yIGEgcGF0aCBpbnNpZGUgYSBtb3VudC4gRGVmYXVsdHMgdG8gdGhlIHNlcnZpY2VcbiAgICogd29ya2VyJ3MgYF9sb2NhbC9gIG5hbWVzcGFjZTsgaW5qZWN0YWJsZSBzbyBkaXNjb3ZlcnkgZG9lcyBub3QgZGVwZW5kIG9uXG4gICAqIHRoZSB2aXJ0dWFsLWZpbGVzeXN0ZW0gbGF5ZXIgKGFuZCBzbyBpdCBjYW4gYmUgdGVzdGVkIHdpdGhvdXQgYSBicm93c2VyKS5cbiAgICovXG4gIHVybEJ1aWxkZXI/OiAobW91bnRJZDogc3RyaW5nLCByZWxhdGl2ZVBhdGg6IHN0cmluZykgPT4gc3RyaW5nO1xuICBvblByb2dyZXNzPzogKHByb2dyZXNzOiBEaXNjb3ZlcnlQcm9ncmVzcykgPT4gdm9pZDtcbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG59XG4iLCAiLyoqXG4gKiBSZWN1cnNpdmUgT01FLVphcnIgZGlzY292ZXJ5LlxuICpcbiAqIEdpdmVuIG1vdW50ZWQgZGlyZWN0b3JpZXMsIGZpbmQgZXZlcnkgbXVsdGlzY2FsZSBPTUUtWmFyciBpbWFnZSBiZWxvdyB0aGVtXG4gKiBhbmQgcmV0dXJuIGEgbm9ybWFsaXplZCBsaXN0IHdpdGggc2FtZS1vcmlnaW4gVVJMcy4gVGhlIHRyYXZlcnNhbCBpc1xuICogZm9ybWF0LWRyaXZlbiByYXRoZXIgdGhhbiBuYW1lLWRyaXZlbjogYSBgLm9tZS56YXJyYCBzdWZmaXggaXMgYSBjb252ZW50aW9uLFxuICogbm90IGEgZ3VhcmFudGVlLCBhbmQgcGxlbnR5IG9mIHZhbGlkIGRhdGFzZXRzIGRvIG5vdCB1c2UgaXQuXG4gKlxuICogVHdvIHJ1bGVzIGtlZXAgdGhlIHdhbGsgY29ycmVjdCBhbmQgY2hlYXA6XG4gKlxuICogIDEuIEEgZ3JvdXAgY2FycnlpbmcgYG11bHRpc2NhbGVzYCBJUyB0aGUgZGF0YXNldC4gVGhlIHdhbGsgc3RvcHMgdGhlcmUsIHNvXG4gKiAgICAgdGhlIHJlc29sdXRpb24gbGV2ZWxzIGJlbmVhdGggaXQgYXJlIG5ldmVyIG1pc3Rha2VuIGZvciBkYXRhc2V0cyBvZlxuICogICAgIHRoZWlyIG93bi5cbiAqICAyLiBBIFphcnIgYXJyYXkgaXMgbmV2ZXIgZGVzY2VuZGVkIGludG8uIEl0cyBjaGlsZHJlbiBhcmUgY2h1bmsgZmlsZXMgYW5kXG4gKiAgICAgY2h1bmsgZGlyZWN0b3JpZXMsIGFuZCBlbnVtZXJhdGluZyB0aGVtIGNvdWxkIG1lYW4gbWlsbGlvbnMgb2YgZW50cmllcy5cbiAqL1xuaW1wb3J0IHR5cGUgeyBNb3VudCB9IGZyb20gJy4uL21vdW50cy9yZWdpc3RyeSc7XG5pbXBvcnQgeyBsb2NhbFVybCB9IGZyb20gJy4uL3Zmcy9jbGllbnQnO1xuaW1wb3J0IHtcbiAgaXNCaW9mb3JtYXRzMlJhd0xheW91dCxcbiAgaXNQbGF0ZSxcbiAgcmVhZEFycmF5SW5mbyxcbiAgcmVhZEpzb25GaWxlLFxuICByZWFkTXVsdGlzY2FsZSxcbiAgcmVhZFphcnJOb2RlLFxuICB0eXBlIE11bHRpc2NhbGVJbmZvLFxuICB0eXBlIFphcnJOb2RlLFxufSBmcm9tICcuL3phcnItbWV0YWRhdGEnO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9MSU1JVFMsXG4gIHR5cGUgRGlzY292ZXJlZERhdGFzZXQsXG4gIHR5cGUgRGlzY292ZXJ5TGltaXRzLFxuICB0eXBlIERpc2NvdmVyeU5vdGUsXG4gIHR5cGUgRGlzY292ZXJ5T3B0aW9ucyxcbiAgdHlwZSBEaXNjb3ZlcnlSZXN1bHQsXG59IGZyb20gJy4vdHlwZXMnO1xuXG4vKiogRW50cmllcyB0aGF0IGFyZSBuZXZlciBwYXJ0IG9mIGEgWmFyciBoaWVyYXJjaHkuICovXG5jb25zdCBJR05PUkVEX05BTUVTID0gbmV3IFNldChbJ19fTUFDT1NYJywgJy5EU19TdG9yZScsICdUaHVtYnMuZGInLCAnLmdpdCddKTtcblxuZnVuY3Rpb24gaXNJZ25vcmVkKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAvLyBEb3RmaWxlcyBhcmUgc2tpcHBlZCBhcyBkaXJlY3RvcmllcywgYnV0IFphcnIgdjIncyBvd24gYC56Z3JvdXBgL2AuemF0dHJzYFxuICAvLyBhcmUgZmlsZXMgYW5kIGFyZSByZWFkIGJ5IG5hbWUsIHNvIG5vdGhpbmcgbmVlZGVkIGlzIGxvc3QgaGVyZS5cbiAgcmV0dXJuIElHTk9SRURfTkFNRVMuaGFzKG5hbWUpIHx8IG5hbWUuc3RhcnRzV2l0aCgnLicpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5lbmRzV2l0aCgnLycpID8gdXJsIDogYCR7dXJsfS9gO1xufVxuXG5mdW5jdGlvbiBkaXNwbGF5TmFtZShyZWxhdGl2ZVBhdGg6IHN0cmluZywgbW91bnQ6IE1vdW50LCBtdWx0aXNjYWxlOiBNdWx0aXNjYWxlSW5mbyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSByZWxhdGl2ZVBhdGggPT09ICcnID8gbW91bnQubmFtZSA6IHJlbGF0aXZlUGF0aC5zbGljZShyZWxhdGl2ZVBhdGgubGFzdEluZGV4T2YoJy8nKSArIDEpO1xuICBjb25zdCBzdHJpcHBlZCA9IGJhc2UucmVwbGFjZSgvXFwub21lXFwuemFyciQvaSwgJycpLnJlcGxhY2UoL1xcLnphcnIkL2ksICcnKTtcbiAgcmV0dXJuIHN0cmlwcGVkIHx8IG11bHRpc2NhbGUubmFtZSB8fCBiYXNlIHx8ICdVbnRpdGxlZCc7XG59XG5cbi8qKiBMb2NhdGlvbiBzaG93biB0byB0aGUgdXNlciBpbiBub3RlcyBhbmQgaW4gdGhlIGdhbGxlcnkuICovXG5mdW5jdGlvbiBkaXNwbGF5UGF0aChyZWxhdGl2ZVBhdGg6IHN0cmluZywgbW91bnQ6IE1vdW50KTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlbGF0aXZlUGF0aCA9PT0gJycgPyBtb3VudC5uYW1lIDogYCR7bW91bnQubmFtZX0vJHtyZWxhdGl2ZVBhdGh9YDtcbn1cblxuaW50ZXJmYWNlIFdhbGtDb250ZXh0IHtcbiAgbW91bnQ6IE1vdW50O1xuICBidWlsZFVybDogKG1vdW50SWQ6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcpID0+IHN0cmluZztcbiAgbGltaXRzOiBEaXNjb3ZlcnlMaW1pdHM7XG4gIGRhdGFzZXRzOiBEaXNjb3ZlcmVkRGF0YXNldFtdO1xuICBub3RlczogRGlzY292ZXJ5Tm90ZVtdO1xuICBkaXJlY3Rvcmllc1NjYW5uZWQ6IG51bWJlcjtcbiAgbGltaXRSZXBvcnRlZDogU2V0PHN0cmluZz47XG4gIG9wdGlvbnM6IERpc2NvdmVyeU9wdGlvbnM7XG59XG5cbmZ1bmN0aW9uIG5vdGUoY29udGV4dDogV2Fsa0NvbnRleHQsIG5vdGU6IERpc2NvdmVyeU5vdGUpOiB2b2lkIHtcbiAgY29udGV4dC5ub3Rlcy5wdXNoKG5vdGUpO1xufVxuXG4vKiogUmVwb3J0IGEgbGltaXQgYXQgbW9zdCBvbmNlIHBlciBraW5kLCBzbyBub3RlcyBzdGF5IHJlYWRhYmxlLiAqL1xuZnVuY3Rpb24gcmVwb3J0TGltaXQoY29udGV4dDogV2Fsa0NvbnRleHQsIGtleTogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGNvbnRleHQubGltaXRSZXBvcnRlZC5oYXMoa2V5KSkgcmV0dXJuO1xuICBjb250ZXh0LmxpbWl0UmVwb3J0ZWQuYWRkKGtleSk7XG4gIG5vdGUoY29udGV4dCwgeyBraW5kOiAnbGltaXQnLCBwYXRoOiBjb250ZXh0Lm1vdW50Lm5hbWUsIG1lc3NhZ2UgfSk7XG59XG5cbi8qKlxuICogUmVhZCB0aGUgaGlnaGVzdC1yZXNvbHV0aW9uIGFycmF5J3Mgc2hhcGUgYW5kIGR0eXBlLlxuICpcbiAqIEJlc3QtZWZmb3J0OiB0aGlzIGlzIGRpc3BsYXkgbWV0YWRhdGEgZm9yIHRoZSBnYWxsZXJ5LCBzbyBhbnkgZmFpbHVyZSBpc1xuICogc3dhbGxvd2VkIHJhdGhlciB0aGFuIHR1cm5lZCBpbnRvIGEgbm90ZSB0aGUgdXNlciBjYW5ub3QgYWN0IG9uLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkU2NhbGVJbmZvKFxuICBkaXJlY3Rvcnk6IEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGUsXG4gIG11bHRpc2NhbGU6IE11bHRpc2NhbGVJbmZvLFxuICBmb3JtYXQ6IDIgfCAzLFxuKTogUHJvbWlzZTx7IHNoYXBlPzogbnVtYmVyW107IGR0eXBlPzogc3RyaW5nIH0+IHtcbiAgY29uc3QgcGF0aCA9IG11bHRpc2NhbGUucGF0aHNbMF07XG4gIGlmICghcGF0aCkgcmV0dXJuIHt9O1xuXG4gIHRyeSB7XG4gICAgbGV0IGN1cnJlbnQgPSBkaXJlY3Rvcnk7XG4gICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHBhdGguc3BsaXQoJy8nKS5maWx0ZXIoQm9vbGVhbikpIHtcbiAgICAgIGN1cnJlbnQgPSBhd2FpdCBjdXJyZW50LmdldERpcmVjdG9yeUhhbmRsZShzZWdtZW50KTtcbiAgICB9XG4gICAgY29uc3QgcmF3ID1cbiAgICAgIGZvcm1hdCA9PT0gM1xuICAgICAgICA/IGF3YWl0IHJlYWRKc29uRmlsZShjdXJyZW50LCAnemFyci5qc29uJylcbiAgICAgICAgOiBhd2FpdCByZWFkSnNvbkZpbGUoY3VycmVudCwgJy56YXJyYXknKTtcbiAgICByZXR1cm4gcmF3ID8gcmVhZEFycmF5SW5mbyhyYXcpIDoge307XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7fTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiByZWNvcmREYXRhc2V0KFxuICBjb250ZXh0OiBXYWxrQ29udGV4dCxcbiAgZGlyZWN0b3J5OiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlLFxuICByZWxhdGl2ZVBhdGg6IHN0cmluZyxcbiAgbm9kZTogRXh0cmFjdDxaYXJyTm9kZSwgeyBraW5kOiAnZ3JvdXAnIH0+LFxuICBtdWx0aXNjYWxlOiBNdWx0aXNjYWxlSW5mbyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IG1vdW50IH0gPSBjb250ZXh0O1xuICBjb25zdCB7IHNoYXBlLCBkdHlwZSB9ID0gYXdhaXQgcmVhZFNjYWxlSW5mbyhkaXJlY3RvcnksIG11bHRpc2NhbGUsIG5vZGUuZm9ybWF0KTtcblxuICBjb250ZXh0LmRhdGFzZXRzLnB1c2goe1xuICAgIGlkOiBgJHttb3VudC5pZH06JHtyZWxhdGl2ZVBhdGggfHwgJy4nfWAsXG4gICAgbmFtZTogZGlzcGxheU5hbWUocmVsYXRpdmVQYXRoLCBtb3VudCwgbXVsdGlzY2FsZSksXG4gICAgcmVsYXRpdmVQYXRoLFxuICAgIHZpcnR1YWxVcmw6IGVuc3VyZVRyYWlsaW5nU2xhc2goY29udGV4dC5idWlsZFVybChtb3VudC5pZCwgcmVsYXRpdmVQYXRoKSksXG4gICAgb21lWmFyclZlcnNpb246IG11bHRpc2NhbGUudmVyc2lvbixcbiAgICBtb3VudElkOiBtb3VudC5pZCxcbiAgICBtb3VudE5hbWU6IG1vdW50Lm5hbWUsXG4gICAgemFyckZvcm1hdDogbm9kZS5mb3JtYXQsXG4gICAgYXhlczogbXVsdGlzY2FsZS5heGVzLFxuICAgIHNoYXBlLFxuICAgIGR0eXBlLFxuICAgIHNjYWxlQ291bnQ6IG11bHRpc2NhbGUucGF0aHMubGVuZ3RoIHx8IHVuZGVmaW5lZCxcbiAgfSk7XG59XG5cbi8qKiBMaXN0IGNoaWxkIGRpcmVjdG9yaWVzLCBob25vdXJpbmcgdGhlIHBlci1kaXJlY3RvcnkgY2FwLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hpbGREaXJlY3RvcmllcyhcbiAgY29udGV4dDogV2Fsa0NvbnRleHQsXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVbXT4ge1xuICBjb25zdCBjaGlsZHJlbjogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZVtdID0gW107XG4gIGxldCBzZWVuID0gMDtcblxuICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIGRpcmVjdG9yeS52YWx1ZXMoKSkge1xuICAgIGlmICgrK3NlZW4gPiBjb250ZXh0LmxpbWl0cy5tYXhFbnRyaWVzUGVyRGlyZWN0b3J5KSB7XG4gICAgICBub3RlKGNvbnRleHQsIHtcbiAgICAgICAga2luZDogJ2xpbWl0JyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogYFN0b3BwZWQgYWZ0ZXIgJHtjb250ZXh0LmxpbWl0cy5tYXhFbnRyaWVzUGVyRGlyZWN0b3J5fSBlbnRyaWVzIGluIHRoaXMgZm9sZGVyLmAsXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAoZW50cnkua2luZCAhPT0gJ2RpcmVjdG9yeScgfHwgaXNJZ25vcmVkKGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICBjaGlsZHJlbi5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIC8vIFN0YWJsZSwgaHVtYW4gb3JkZXI6IGAwLCAxLCAyLCAxMGAgcmF0aGVyIHRoYW4gYDAsIDEsIDEwLCAyYC5cbiAgY2hpbGRyZW4uc29ydCgoYSwgYikgPT4gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lLCB1bmRlZmluZWQsIHsgbnVtZXJpYzogdHJ1ZSB9KSk7XG4gIHJldHVybiBjaGlsZHJlbjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FsayhcbiAgY29udGV4dDogV2Fsa0NvbnRleHQsXG4gIGRpcmVjdG9yeTogRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZSxcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4gIGRlcHRoOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29udGV4dC5vcHRpb25zLnNpZ25hbD8udGhyb3dJZkFib3J0ZWQoKTtcblxuICBpZiAoY29udGV4dC5kYXRhc2V0cy5sZW5ndGggPj0gY29udGV4dC5saW1pdHMubWF4RGF0YXNldHMpIHtcbiAgICByZXBvcnRMaW1pdChcbiAgICAgIGNvbnRleHQsXG4gICAgICAnZGF0YXNldHMnLFxuICAgICAgYFN0b3BwZWQgYWZ0ZXIgJHtjb250ZXh0LmxpbWl0cy5tYXhEYXRhc2V0c30gZGF0YXNldHM7IHRoZSBmb2xkZXIgY29udGFpbnMgbW9yZS5gLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChjb250ZXh0LmRpcmVjdG9yaWVzU2Nhbm5lZCA+PSBjb250ZXh0LmxpbWl0cy5tYXhEaXJlY3Rvcmllcykge1xuICAgIHJlcG9ydExpbWl0KFxuICAgICAgY29udGV4dCxcbiAgICAgICdkaXJlY3RvcmllcycsXG4gICAgICBgU3RvcHBlZCBhZnRlciBzY2FubmluZyAke2NvbnRleHQubGltaXRzLm1heERpcmVjdG9yaWVzfSBmb2xkZXJzLmAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb250ZXh0LmRpcmVjdG9yaWVzU2Nhbm5lZCArPSAxO1xuICBjb250ZXh0Lm9wdGlvbnMub25Qcm9ncmVzcz8uKHtcbiAgICBkaXJlY3Rvcmllc1NjYW5uZWQ6IGNvbnRleHQuZGlyZWN0b3JpZXNTY2FubmVkLFxuICAgIGRhdGFzZXRzRm91bmQ6IGNvbnRleHQuZGF0YXNldHMubGVuZ3RoLFxuICAgIGN1cnJlbnRQYXRoOiBkaXNwbGF5UGF0aChyZWxhdGl2ZVBhdGgsIGNvbnRleHQubW91bnQpLFxuICB9KTtcblxuICBsZXQgbm9kZTogWmFyck5vZGU7XG4gIHRyeSB7XG4gICAgbm9kZSA9IGF3YWl0IHJlYWRaYXJyTm9kZShkaXJlY3RvcnkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG5vdGUoY29udGV4dCwge1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IGRpc3BsYXlQYXRoKHJlbGF0aXZlUGF0aCwgY29udGV4dC5tb3VudCksXG4gICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKG5vZGUua2luZCA9PT0gJ2FycmF5Jykge1xuICAgIC8vIFJ1bGUgMi4gQXQgdGhlIHRvcCBsZXZlbCB0aGlzIGlzIHdvcnRoIHJlcG9ydGluZywgYmVjYXVzZSB0aGUgdXNlclxuICAgIC8vIHBvaW50ZWQgYXQgaXQgZGVsaWJlcmF0ZWx5OyBkZWVwZXIgZG93biBpdCBpcyBqdXN0IGEgcmVzb2x1dGlvbiBsZXZlbC5cbiAgICBpZiAoZGVwdGggPT09IDApIHtcbiAgICAgIG5vdGUoY29udGV4dCwge1xuICAgICAgICBraW5kOiAndW5zdXBwb3J0ZWQnLFxuICAgICAgICBwYXRoOiBkaXNwbGF5UGF0aChyZWxhdGl2ZVBhdGgsIGNvbnRleHQubW91bnQpLFxuICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICdUaGlzIGlzIGEgYmFyZSBaYXJyIGFycmF5LCBub3QgYW4gT01FLVphcnIgbXVsdGlzY2FsZSBpbWFnZS4gRHJvcCB0aGUgZ3JvdXAgdGhhdCBjb250YWlucyBpdC4nLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChub2RlLmtpbmQgPT09ICdncm91cCcpIHtcbiAgICBjb25zdCBtdWx0aXNjYWxlID0gcmVhZE11bHRpc2NhbGUobm9kZSk7XG4gICAgaWYgKG11bHRpc2NhbGUpIHtcbiAgICAgIC8vIFJ1bGUgMS5cbiAgICAgIGF3YWl0IHJlY29yZERhdGFzZXQoY29udGV4dCwgZGlyZWN0b3J5LCByZWxhdGl2ZVBhdGgsIG5vZGUsIG11bHRpc2NhbGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChpc1BsYXRlKG5vZGUpKSB7XG4gICAgICAvLyBBIHBsYXRlIGlzIG5vdCBpdHNlbGYgb3BlbmFibGUgYXMgYW4gaW1hZ2UsIGJ1dCB0aGUgZmllbGQtb2Ytdmlld1xuICAgICAgLy8gaW1hZ2VzIGluc2lkZSBpdCBhcmUsIHNvIGtlZXAgd2Fsa2luZyBhbmQgc2F5IHdoYXQgd2UgZGlkLlxuICAgICAgbm90ZShjb250ZXh0LCB7XG4gICAgICAgIGtpbmQ6ICdza2lwcGVkJyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogJ0hDUyBwbGF0ZTogbGlzdGluZyB0aGUgaW1hZ2VzIGluc2lkZSBpdCBpbmRpdmlkdWFsbHkuJyxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoaXNCaW9mb3JtYXRzMlJhd0xheW91dChub2RlKSkge1xuICAgICAgbm90ZShjb250ZXh0LCB7XG4gICAgICAgIGtpbmQ6ICdza2lwcGVkJyxcbiAgICAgICAgcGF0aDogZGlzcGxheVBhdGgocmVsYXRpdmVQYXRoLCBjb250ZXh0Lm1vdW50KSxcbiAgICAgICAgbWVzc2FnZTogJ2Jpb2Zvcm1hdHMycmF3IGNvbnRhaW5lcjogbGlzdGluZyBpdHMgaW1hZ2Ugc2VyaWVzIGluZGl2aWR1YWxseS4nLFxuICAgICAgfSk7XG4gICAgfVxuICAgIC8vIEFueSBvdGhlciBncm91cCBcdTIwMTQgYSB3ZWxsLCBhIHBsYWluIGNvbnRhaW5lciBcdTIwMTQgZmFsbHMgdGhyb3VnaCB0byB0aGVcbiAgICAvLyByZWN1cnNpb24gYmVsb3csIHdoaWNoIGlzIGhvdyBuZXN0ZWQgZGF0YXNldHMgYXJlIGZvdW5kLlxuICB9XG5cbiAgaWYgKGRlcHRoID49IGNvbnRleHQubGltaXRzLm1heERlcHRoKSB7XG4gICAgcmVwb3J0TGltaXQoXG4gICAgICBjb250ZXh0LFxuICAgICAgJ2RlcHRoJyxcbiAgICAgIGBTdG9wcGVkIGF0ICR7Y29udGV4dC5saW1pdHMubWF4RGVwdGh9IGZvbGRlcnMgZGVlcDsgZGVlcGVyIGRhdGFzZXRzIHdlcmUgbm90IHNlYXJjaGVkLmAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgY2hpbGRyZW46IEZpbGVTeXN0ZW1EaXJlY3RvcnlIYW5kbGVbXTtcbiAgdHJ5IHtcbiAgICBjaGlsZHJlbiA9IGF3YWl0IGNoaWxkRGlyZWN0b3JpZXMoY29udGV4dCwgZGlyZWN0b3J5LCByZWxhdGl2ZVBhdGgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIG5vdGUoY29udGV4dCwge1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IGRpc3BsYXlQYXRoKHJlbGF0aXZlUGF0aCwgY29udGV4dC5tb3VudCksXG4gICAgICBtZXNzYWdlOiBgQ291bGQgbm90IGxpc3QgdGhpcyBmb2xkZXI6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWAsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgIGNvbnN0IGNoaWxkUGF0aCA9IHJlbGF0aXZlUGF0aCA9PT0gJycgPyBjaGlsZC5uYW1lIDogYCR7cmVsYXRpdmVQYXRofS8ke2NoaWxkLm5hbWV9YDtcbiAgICBhd2FpdCB3YWxrKGNvbnRleHQsIGNoaWxkLCBjaGlsZFBhdGgsIGRlcHRoICsgMSk7XG4gIH1cbn1cblxuLyoqIERpc2NvdmVyIGRhdGFzZXRzIGluIGEgc2luZ2xlIG1vdW50LiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRpc2NvdmVySW5Nb3VudChcbiAgbW91bnQ6IE1vdW50LFxuICBvcHRpb25zOiBEaXNjb3ZlcnlPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPERpc2NvdmVyeVJlc3VsdD4ge1xuICBjb25zdCBjb250ZXh0OiBXYWxrQ29udGV4dCA9IHtcbiAgICBtb3VudCxcbiAgICBidWlsZFVybDogb3B0aW9ucy51cmxCdWlsZGVyID8/IGxvY2FsVXJsLFxuICAgIGxpbWl0czogeyAuLi5ERUZBVUxUX0xJTUlUUywgLi4ub3B0aW9ucy5saW1pdHMgfSxcbiAgICBkYXRhc2V0czogW10sXG4gICAgbm90ZXM6IFtdLFxuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogMCxcbiAgICBsaW1pdFJlcG9ydGVkOiBuZXcgU2V0KCksXG4gICAgb3B0aW9ucyxcbiAgfTtcblxuICB0cnkge1xuICAgIGF3YWl0IHdhbGsoY29udGV4dCwgbW91bnQuaGFuZGxlLCAnJywgMCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKG9wdGlvbnMuc2lnbmFsPy5hYm9ydGVkKSB0aHJvdyBlcnJvcjtcbiAgICBjb250ZXh0Lm5vdGVzLnB1c2goe1xuICAgICAga2luZDogJ2Vycm9yJyxcbiAgICAgIHBhdGg6IG1vdW50Lm5hbWUsXG4gICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGRhdGFzZXRzOiBjb250ZXh0LmRhdGFzZXRzLFxuICAgIG5vdGVzOiBjb250ZXh0Lm5vdGVzLFxuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogY29udGV4dC5kaXJlY3Rvcmllc1NjYW5uZWQsXG4gIH07XG59XG5cbi8qKlxuICogRGlzY292ZXIgZGF0YXNldHMgYWNyb3NzIHNldmVyYWwgbW91bnRzLCBhY2N1bXVsYXRpbmcgcHJvZ3Jlc3Mgc28gYSBkcm9wIG9mXG4gKiBtdWx0aXBsZSBmb2xkZXJzIHJlYWRzIGFzIG9uZSBvcGVyYXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlckluTW91bnRzKFxuICBtb3VudHM6IE1vdW50W10sXG4gIG9wdGlvbnM6IERpc2NvdmVyeU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8RGlzY292ZXJ5UmVzdWx0PiB7XG4gIGNvbnN0IGRhdGFzZXRzOiBEaXNjb3ZlcmVkRGF0YXNldFtdID0gW107XG4gIGNvbnN0IG5vdGVzOiBEaXNjb3ZlcnlOb3RlW10gPSBbXTtcbiAgbGV0IGRpcmVjdG9yaWVzU2Nhbm5lZCA9IDA7XG5cbiAgZm9yIChjb25zdCBtb3VudCBvZiBtb3VudHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckluTW91bnQobW91bnQsIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBvblByb2dyZXNzOiBvcHRpb25zLm9uUHJvZ3Jlc3NcbiAgICAgICAgPyAocHJvZ3Jlc3MpID0+XG4gICAgICAgICAgICBvcHRpb25zLm9uUHJvZ3Jlc3M/Lih7XG4gICAgICAgICAgICAgIGRpcmVjdG9yaWVzU2Nhbm5lZDogZGlyZWN0b3JpZXNTY2FubmVkICsgcHJvZ3Jlc3MuZGlyZWN0b3JpZXNTY2FubmVkLFxuICAgICAgICAgICAgICBkYXRhc2V0c0ZvdW5kOiBkYXRhc2V0cy5sZW5ndGggKyBwcm9ncmVzcy5kYXRhc2V0c0ZvdW5kLFxuICAgICAgICAgICAgICBjdXJyZW50UGF0aDogcHJvZ3Jlc3MuY3VycmVudFBhdGgsXG4gICAgICAgICAgICB9KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICBkYXRhc2V0cy5wdXNoKC4uLnJlc3VsdC5kYXRhc2V0cyk7XG4gICAgbm90ZXMucHVzaCguLi5yZXN1bHQubm90ZXMpO1xuICAgIGRpcmVjdG9yaWVzU2Nhbm5lZCArPSByZXN1bHQuZGlyZWN0b3JpZXNTY2FubmVkO1xuICB9XG5cbiAgcmV0dXJuIHsgZGF0YXNldHMsIG5vdGVzLCBkaXJlY3Rvcmllc1NjYW5uZWQgfTtcbn1cbiIsICIvKipcbiAqIEJ1aWxkcyBhbiBvbi1kaXNrIHRyZWUgZXhlcmNpc2luZyB0aGUgbGF5b3V0cyBkaXNjb3ZlcnkgaGFzIHRvIHRlbGwgYXBhcnQ6XG4gKiBaYXJyIHYyIGFuZCB2MyBtdWx0aXNjYWxlcywgcmVzb2x1dGlvbiBsZXZlbHMgdGhhdCBtdXN0IE5PVCBiZSBtaXN0YWtlbiBmb3JcbiAqIGRhdGFzZXRzLCBhIGJhcmUgYXJyYXksIGFuIEhDUyBwbGF0ZSwgYW5kIGFzc29ydGVkIG5vaXNlLlxuICovXG5pbXBvcnQgeyBwcm9taXNlcyBhcyBmcyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgbWtkdGVtcCB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVKc29uKHBhdGg6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZnMubWtkaXIoam9pbihwYXRoLCAnLi4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShwYXRoLCBKU09OLnN0cmluZ2lmeSh2YWx1ZSwgbnVsbCwgMikpO1xufVxuXG4vKiogQSB2MiBtdWx0aXNjYWxlIGltYWdlIHdpdGggdHdvIHJlc29sdXRpb24gbGV2ZWxzIGFuZCByZWFsIGNodW5rIGZpbGVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFrZVYySW1hZ2Uocm9vdDogc3RyaW5nLCBsZXZlbHMgPSAyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsICcuemdyb3VwJyksIHsgemFycl9mb3JtYXQ6IDIgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsICcuemF0dHJzJyksIHtcbiAgICBtdWx0aXNjYWxlczogW1xuICAgICAge1xuICAgICAgICB2ZXJzaW9uOiAnMC40JyxcbiAgICAgICAgbmFtZTogJ2V4YW1wbGUnLFxuICAgICAgICBheGVzOiBbXG4gICAgICAgICAgeyBuYW1lOiAnYycsIHR5cGU6ICdjaGFubmVsJyB9LFxuICAgICAgICAgIHsgbmFtZTogJ3knLCB0eXBlOiAnc3BhY2UnLCB1bml0OiAnbWljcm9tZXRlcicgfSxcbiAgICAgICAgICB7IG5hbWU6ICd4JywgdHlwZTogJ3NwYWNlJywgdW5pdDogJ21pY3JvbWV0ZXInIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGRhdGFzZXRzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBsZXZlbHMgfSwgKF8sIGluZGV4KSA9PiAoe1xuICAgICAgICAgIHBhdGg6IFN0cmluZyhpbmRleCksXG4gICAgICAgICAgY29vcmRpbmF0ZVRyYW5zZm9ybWF0aW9uczogW3sgdHlwZTogJ3NjYWxlJywgc2NhbGU6IFsxLCAyICoqIGluZGV4LCAyICoqIGluZGV4XSB9XSxcbiAgICAgICAgfSkpLFxuICAgICAgfSxcbiAgICBdLFxuICB9KTtcblxuICBmb3IgKGxldCBsZXZlbCA9IDA7IGxldmVsIDwgbGV2ZWxzOyBsZXZlbCArPSAxKSB7XG4gICAgY29uc3Qgc2l6ZSA9IDY0ID4+IGxldmVsO1xuICAgIGF3YWl0IHdyaXRlSnNvbihqb2luKHJvb3QsIFN0cmluZyhsZXZlbCksICcuemFycmF5JyksIHtcbiAgICAgIHphcnJfZm9ybWF0OiAyLFxuICAgICAgc2hhcGU6IFsyLCBzaXplLCBzaXplXSxcbiAgICAgIGNodW5rczogWzEsIHNpemUsIHNpemVdLFxuICAgICAgZHR5cGU6ICc8dTInLFxuICAgICAgY29tcHJlc3NvcjogbnVsbCxcbiAgICAgIGZpbGxfdmFsdWU6IDAsXG4gICAgICBvcmRlcjogJ0MnLFxuICAgICAgZmlsdGVyczogbnVsbCxcbiAgICB9KTtcbiAgICAvLyBDaHVuayBrZXlzIHVzZSBuZXN0ZWQgZGlyZWN0b3JpZXMsIHRoZSBzaGFwZSB0aGF0IG11c3QgbmV2ZXIgYmUgd2Fsa2VkXG4gICAgLy8gaW50byBhcyBpZiBpdCB3ZXJlIGEgZGF0YXNldCBoaWVyYXJjaHkuXG4gICAgZm9yIChsZXQgY2hhbm5lbCA9IDA7IGNoYW5uZWwgPCAyOyBjaGFubmVsICs9IDEpIHtcbiAgICAgIGNvbnN0IGNodW5rUGF0aCA9IGpvaW4ocm9vdCwgU3RyaW5nKGxldmVsKSwgU3RyaW5nKGNoYW5uZWwpLCAnMCcsICcwJyk7XG4gICAgICBhd2FpdCBmcy5ta2Rpcihqb2luKGNodW5rUGF0aCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgYXdhaXQgZnMud3JpdGVGaWxlKGNodW5rUGF0aCwgQnVmZmVyLmFsbG9jKHNpemUgKiBzaXplICogMiwgbGV2ZWwgKyAxKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKiBBIHYzIG11bHRpc2NhbGUgaW1hZ2Ugd2l0aCBPTUUgbWV0YWRhdGEgdW5kZXIgYGF0dHJpYnV0ZXMub21lYC4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1ha2VWM0ltYWdlKHJvb3Q6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCB3cml0ZUpzb24oam9pbihyb290LCAnemFyci5qc29uJyksIHtcbiAgICB6YXJyX2Zvcm1hdDogMyxcbiAgICBub2RlX3R5cGU6ICdncm91cCcsXG4gICAgYXR0cmlidXRlczoge1xuICAgICAgb21lOiB7XG4gICAgICAgIHZlcnNpb246ICcwLjUnLFxuICAgICAgICBtdWx0aXNjYWxlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICd2MyBleGFtcGxlJyxcbiAgICAgICAgICAgIGF4ZXM6IFtcbiAgICAgICAgICAgICAgeyBuYW1lOiAneicsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgICAgeyBuYW1lOiAneScsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgICAgeyBuYW1lOiAneCcsIHR5cGU6ICdzcGFjZScgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBkYXRhc2V0czogW1xuICAgICAgICAgICAgICB7IHBhdGg6ICcwJywgY29vcmRpbmF0ZVRyYW5zZm9ybWF0aW9uczogW3sgdHlwZTogJ3NjYWxlJywgc2NhbGU6IFsxLCAxLCAxXSB9XSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocm9vdCwgJzAnLCAnemFyci5qc29uJyksIHtcbiAgICB6YXJyX2Zvcm1hdDogMyxcbiAgICBub2RlX3R5cGU6ICdhcnJheScsXG4gICAgc2hhcGU6IFs4LCAzMiwgMzJdLFxuICAgIGRhdGFfdHlwZTogJ3VpbnQ4JyxcbiAgICBjaHVua19ncmlkOiB7IG5hbWU6ICdyZWd1bGFyJywgY29uZmlndXJhdGlvbjogeyBjaHVua19zaGFwZTogWzgsIDMyLCAzMl0gfSB9LFxuICAgIGNodW5rX2tleV9lbmNvZGluZzogeyBuYW1lOiAnZGVmYXVsdCcgfSxcbiAgICBjb2RlY3M6IFt7IG5hbWU6ICdieXRlcycsIGNvbmZpZ3VyYXRpb246IHsgZW5kaWFuOiAnbGl0dGxlJyB9IH1dLFxuICAgIGZpbGxfdmFsdWU6IDAsXG4gIH0pO1xuICBjb25zdCBjaHVuayA9IGpvaW4ocm9vdCwgJzAnLCAnYycsICcwJywgJzAnLCAnMCcpO1xuICBhd2FpdCBmcy5ta2Rpcihqb2luKGNodW5rLCAnLi4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShjaHVuaywgQnVmZmVyLmFsbG9jKDggKiAzMiAqIDMyLCA3KSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRml4dHVyZSB7XG4gIHJvb3Q6IHN0cmluZztcbiAgY2xlYW51cDogKCkgPT4gUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1ha2VGaXh0dXJlKCk6IFByb21pc2U8Rml4dHVyZT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWtkdGVtcChqb2luKHRtcGRpcigpLCAnb21lLXphcnItcG9ydGFsLScpKTtcblxuICAvLyBBIGRhdGFzZXQgZGlyZWN0bHkgdW5kZXIgdGhlIGRyb3Agcm9vdC5cbiAgYXdhaXQgbWFrZVYySW1hZ2Uoam9pbihyb290LCAndjItaW1hZ2Uub21lLnphcnInKSk7XG5cbiAgLy8gQSBkYXRhc2V0IGJ1cmllZCBhIGZldyBwbGFpbiBmb2xkZXJzIGRvd24uXG4gIGF3YWl0IG1ha2VWM0ltYWdlKGpvaW4ocm9vdCwgJ25lc3RlZCcsICdkZWVwZXInLCAndjMtaW1hZ2Uub21lLnphcnInKSk7XG5cbiAgLy8gQSBiYXJlIGFycmF5OiB2YWxpZCBaYXJyLCBidXQgbm90IGFuIE9NRS1aYXJyIGltYWdlLlxuICBhd2FpdCB3cml0ZUpzb24oam9pbihyb290LCAnYmFyZS1hcnJheS56YXJyJywgJy56YXJyYXknKSwge1xuICAgIHphcnJfZm9ybWF0OiAyLFxuICAgIHNoYXBlOiBbNCwgNF0sXG4gICAgY2h1bmtzOiBbNCwgNF0sXG4gICAgZHR5cGU6ICc8ZjQnLFxuICAgIGNvbXByZXNzb3I6IG51bGwsXG4gICAgZmlsbF92YWx1ZTogMCxcbiAgICBvcmRlcjogJ0MnLFxuICAgIGZpbHRlcnM6IG51bGwsXG4gIH0pO1xuXG4gIC8vIEFuIEhDUyBwbGF0ZTogbm90IG9wZW5hYmxlIGl0c2VsZiwgYnV0IGl0cyBmaWVsZHMgb2YgdmlldyBhcmUuXG4gIGNvbnN0IHBsYXRlID0gam9pbihyb290LCAncGxhdGUub21lLnphcnInKTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocGxhdGUsICcuemdyb3VwJyksIHsgemFycl9mb3JtYXQ6IDIgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHBsYXRlLCAnLnphdHRycycpLCB7XG4gICAgcGxhdGU6IHtcbiAgICAgIHZlcnNpb246ICcwLjQnLFxuICAgICAgY29sdW1uczogW3sgbmFtZTogJzEnIH1dLFxuICAgICAgcm93czogW3sgbmFtZTogJ0EnIH1dLFxuICAgICAgd2VsbHM6IFt7IHBhdGg6ICdBLzEnLCByb3dJbmRleDogMCwgY29sdW1uSW5kZXg6IDAgfV0sXG4gICAgfSxcbiAgfSk7XG4gIGF3YWl0IHdyaXRlSnNvbihqb2luKHBsYXRlLCAnQScsICcxJywgJy56Z3JvdXAnKSwgeyB6YXJyX2Zvcm1hdDogMiB9KTtcbiAgYXdhaXQgd3JpdGVKc29uKGpvaW4ocGxhdGUsICdBJywgJzEnLCAnLnphdHRycycpLCB7XG4gICAgd2VsbDogeyB2ZXJzaW9uOiAnMC40JywgaW1hZ2VzOiBbeyBwYXRoOiAnMCcgfV0gfSxcbiAgfSk7XG4gIGF3YWl0IG1ha2VWMkltYWdlKGpvaW4ocGxhdGUsICdBJywgJzEnLCAnMCcpLCAxKTtcblxuICAvLyBOb2lzZSB0aGF0IG11c3QgYmUgaWdub3JlZC5cbiAgYXdhaXQgZnMud3JpdGVGaWxlKGpvaW4ocm9vdCwgJ1JFQURNRS50eHQnKSwgJ25vdCBhIGRhdGFzZXQnKTtcbiAgYXdhaXQgZnMubWtkaXIoam9pbihyb290LCAnX19NQUNPU1gnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLm1rZGlyKGpvaW4ocm9vdCwgJy5oaWRkZW4nKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGZzLndyaXRlRmlsZShqb2luKHJvb3QsICcuaGlkZGVuJywgJ3NlY3JldCcpLCAnaWdub3JlZCcpO1xuXG4gIHJldHVybiB7XG4gICAgcm9vdCxcbiAgICBjbGVhbnVwOiAoKSA9PiBmcy5ybShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSksXG4gIH07XG59XG4iLCAiLyoqXG4gKiBBIGBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlYCBpbXBsZW1lbnRhdGlvbiBiYWNrZWQgYnkgbm9kZTpmcy5cbiAqXG4gKiBUaGUgcG9ydGFsJ3MgZGlzY292ZXJ5IGFuZCBzZXJ2aW5nIGxheWVycyBhcmUgd3JpdHRlbiBhZ2FpbnN0IHRoZSBGaWxlXG4gKiBTeXN0ZW0gQWNjZXNzIEFQSSBhbmQgbm90aGluZyBlbHNlLCBzbyBhIGZhaXRoZnVsIGFkYXB0ZXIgbGV0cyBib3RoIGJlXG4gKiB0ZXN0ZWQgYWdhaW5zdCByZWFsIGRpcmVjdG9yeSB0cmVlcyB3aXRob3V0IGEgYnJvd3Nlci5cbiAqL1xuaW1wb3J0IHsgcHJvbWlzZXMgYXMgZnMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5mdW5jdGlvbiBub3RGb3VuZChuYW1lOiBzdHJpbmcpOiBET01FeGNlcHRpb24ge1xuICByZXR1cm4gbmV3IERPTUV4Y2VwdGlvbihgTm8gZW50cnkgbmFtZWQgJHtuYW1lfWAsICdOb3RGb3VuZEVycm9yJyk7XG59XG5cbmZ1bmN0aW9uIHR5cGVNaXNtYXRjaChuYW1lOiBzdHJpbmcpOiBET01FeGNlcHRpb24ge1xuICByZXR1cm4gbmV3IERPTUV4Y2VwdGlvbihgRW50cnkgJHtuYW1lfSBpcyB0aGUgd3JvbmcgdHlwZWAsICdUeXBlTWlzbWF0Y2hFcnJvcicpO1xufVxuXG5jbGFzcyBOb2RlRmlsZUhhbmRsZSB7XG4gIHJlYWRvbmx5IGtpbmQgPSAnZmlsZScgYXMgY29uc3Q7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgbmFtZTogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgcGF0aDogc3RyaW5nLFxuICApIHt9XG5cbiAgYXN5bmMgZ2V0RmlsZSgpOiBQcm9taXNlPEZpbGU+IHtcbiAgICBjb25zdCBbZGF0YSwgc3RhdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbZnMucmVhZEZpbGUodGhpcy5wYXRoKSwgZnMuc3RhdCh0aGlzLnBhdGgpXSk7XG4gICAgcmV0dXJuIG5ldyBGaWxlKFtkYXRhXSwgdGhpcy5uYW1lLCB7IGxhc3RNb2RpZmllZDogc3RhdC5tdGltZU1zIH0pO1xuICB9XG59XG5cbmNsYXNzIE5vZGVEaXJlY3RvcnlIYW5kbGUge1xuICByZWFkb25seSBraW5kID0gJ2RpcmVjdG9yeScgYXMgY29uc3Q7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgbmFtZTogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgcGF0aDogc3RyaW5nLFxuICApIHt9XG5cbiAgYXN5bmMgZ2V0RmlsZUhhbmRsZShuYW1lOiBzdHJpbmcpOiBQcm9taXNlPE5vZGVGaWxlSGFuZGxlPiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gam9pbih0aGlzLnBhdGgsIG5hbWUpO1xuICAgIGxldCBzdGF0O1xuICAgIHRyeSB7XG4gICAgICBzdGF0ID0gYXdhaXQgZnMuc3RhdCh0YXJnZXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbm90Rm91bmQobmFtZSk7XG4gICAgfVxuICAgIGlmICghc3RhdC5pc0ZpbGUoKSkgdGhyb3cgdHlwZU1pc21hdGNoKG5hbWUpO1xuICAgIHJldHVybiBuZXcgTm9kZUZpbGVIYW5kbGUobmFtZSwgdGFyZ2V0KTtcbiAgfVxuXG4gIGFzeW5jIGdldERpcmVjdG9yeUhhbmRsZShuYW1lOiBzdHJpbmcpOiBQcm9taXNlPE5vZGVEaXJlY3RvcnlIYW5kbGU+IHtcbiAgICBjb25zdCB0YXJnZXQgPSBqb2luKHRoaXMucGF0aCwgbmFtZSk7XG4gICAgbGV0IHN0YXQ7XG4gICAgdHJ5IHtcbiAgICAgIHN0YXQgPSBhd2FpdCBmcy5zdGF0KHRhcmdldCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBub3RGb3VuZChuYW1lKTtcbiAgICB9XG4gICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIHRocm93IHR5cGVNaXNtYXRjaChuYW1lKTtcbiAgICByZXR1cm4gbmV3IE5vZGVEaXJlY3RvcnlIYW5kbGUobmFtZSwgdGFyZ2V0KTtcbiAgfVxuXG4gIGFzeW5jICp2YWx1ZXMoKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPE5vZGVEaXJlY3RvcnlIYW5kbGUgfCBOb2RlRmlsZUhhbmRsZT4ge1xuICAgIGNvbnN0IGVudHJpZXMgPSBhd2FpdCBmcy5yZWFkZGlyKHRoaXMucGF0aCwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gam9pbih0aGlzLnBhdGgsIGVudHJ5Lm5hbWUpO1xuICAgICAgeWllbGQgZW50cnkuaXNEaXJlY3RvcnkoKVxuICAgICAgICA/IG5ldyBOb2RlRGlyZWN0b3J5SGFuZGxlKGVudHJ5Lm5hbWUsIHRhcmdldClcbiAgICAgICAgOiBuZXcgTm9kZUZpbGVIYW5kbGUoZW50cnkubmFtZSwgdGFyZ2V0KTtcbiAgICB9XG4gIH1cblxuICBhc3luYyAqZW50cmllcygpOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8W3N0cmluZywgTm9kZURpcmVjdG9yeUhhbmRsZSB8IE5vZGVGaWxlSGFuZGxlXT4ge1xuICAgIGZvciBhd2FpdCAoY29uc3QgaGFuZGxlIG9mIHRoaXMudmFsdWVzKCkpIHlpZWxkIFtoYW5kbGUubmFtZSwgaGFuZGxlXTtcbiAgfVxuXG4gIGFzeW5jICprZXlzKCk6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxzdHJpbmc+IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGhhbmRsZSBvZiB0aGlzLnZhbHVlcygpKSB5aWVsZCBoYW5kbGUubmFtZTtcbiAgfVxuXG4gIGFzeW5jIHF1ZXJ5UGVybWlzc2lvbigpOiBQcm9taXNlPFBlcm1pc3Npb25TdGF0ZT4ge1xuICAgIHJldHVybiAnZ3JhbnRlZCc7XG4gIH1cblxuICBhc3luYyByZXF1ZXN0UGVybWlzc2lvbigpOiBQcm9taXNlPFBlcm1pc3Npb25TdGF0ZT4ge1xuICAgIHJldHVybiAnZ3JhbnRlZCc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRpcmVjdG9yeUhhbmRsZShwYXRoOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiBGaWxlU3lzdGVtRGlyZWN0b3J5SGFuZGxlIHtcbiAgcmV0dXJuIG5ldyBOb2RlRGlyZWN0b3J5SGFuZGxlKFxuICAgIG5hbWUgPz8gcGF0aC5zbGljZShwYXRoLmxhc3RJbmRleE9mKCcvJykgKyAxKSxcbiAgICBwYXRoLFxuICApIGFzIHVua25vd24gYXMgRmlsZVN5c3RlbURpcmVjdG9yeUhhbmRsZTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxP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LFdBQVc7QUFBQSxJQUNmO0FBQ0EsV0FBTyxNQUFNLE9BQU8sU0FBUyxRQUFRLENBQUM7QUFDdEMsV0FBTyxNQUFNLE9BQU8sTUFBTSxRQUFRLENBQUM7QUFDbkMsV0FBTyxNQUFNLE9BQU8sTUFBTSxDQUFDLEVBQUUsTUFBTSxhQUFhO0FBQ2hELFdBQU8sTUFBTSxPQUFPLE1BQU0sQ0FBQyxFQUFFLFNBQVMsaUJBQWlCO0FBQUEsRUFDekQsQ0FBQztBQUVELEtBQUcsNENBQTRDLFlBQVk7QUFDekQsVUFBTSxVQUFVLE1BQU0sZ0JBQWdCLFNBQVMsUUFBUSxNQUFNLE1BQU0sR0FBRztBQUFBLE1BQ3BFO0FBQUEsTUFDQSxRQUFRLEVBQUUsYUFBYSxFQUFFO0FBQUEsSUFDM0IsQ0FBQztBQUNELFdBQU8sTUFBTSxRQUFRLFNBQVMsUUFBUSxDQUFDO0FBQ3ZDLFdBQU8sR0FBRyxRQUFRLE1BQU0sS0FBSyxDQUFDRCxVQUFTQSxNQUFLLFNBQVMsT0FBTyxDQUFDO0FBQUEsRUFDL0QsQ0FBQztBQUVELEtBQUcsd0RBQXdELFlBQVk7QUFDckUsVUFBTSxVQUFVLE1BQU0sZ0JBQWdCLFNBQVMsUUFBUSxNQUFNLE1BQU0sR0FBRztBQUFBLE1BQ3BFO0FBQUEsTUFDQSxRQUFRLEVBQUUsVUFBVSxFQUFFO0FBQUEsSUFDeEIsQ0FBQztBQUNELFdBQU87QUFBQSxNQUNMLFFBQVEsU0FBUyxJQUFJLENBQUMsWUFBWSxRQUFRLFlBQVk7QUFBQSxNQUN0RCxDQUFDLG1CQUFtQjtBQUFBLElBQ3RCO0FBQ0EsV0FBTyxHQUFHLFFBQVEsTUFBTSxLQUFLLENBQUNBLFVBQVNBLE1BQUssU0FBUyxPQUFPLENBQUM7QUFBQSxFQUMvRCxDQUFDO0FBRUQsS0FBRyxnQ0FBZ0MsWUFBWTtBQUM3QyxVQUFNLE9BQWlCLENBQUM7QUFDeEIsVUFBTSxnQkFBZ0IsU0FBUyxRQUFRLE1BQU0sTUFBTSxHQUFHO0FBQUEsTUFDcEQ7QUFBQSxNQUNBLFlBQVksQ0FBQyxhQUFhLEtBQUssS0FBSyxTQUFTLGtCQUFrQjtBQUFBLElBQ2pFLENBQUM7QUFDRCxXQUFPLEdBQUcsS0FBSyxTQUFTLENBQUM7QUFDekIsV0FBTyxVQUFVLE1BQU0sQ0FBQyxHQUFHLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxNQUFNLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDeEQsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbImpvaW4iLCAiYmFzZVBhdGgiLCAibm90ZSIsICJmcyIsICJqb2luIiwgIm5vdGUiLCAiam9pbiJdCn0K
