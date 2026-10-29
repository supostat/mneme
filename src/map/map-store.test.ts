import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusPaths, resolveCorpus } from "../corpus";
import type { CorpusPaths } from "../corpus";
import { MapSectionValidationError, serializeMapSection } from "./map-section";
import type { MapSection, MapSectionFrontmatter } from "./map-section";
import {
  MAP_INDEX_HEADING,
  findDanglingDependencies,
  listSectionFiles,
  readMapSections,
  readSectionFiles,
  removeMapSection,
  renderGlossary,
  renderMapIndex,
  sectionPath,
  writeDerivedFiles,
  writeMapSection,
} from "./map-store";

const fixedClock = () => new Date("2026-07-06T10:00:00.000Z");

async function provisionedCorpus(): Promise<CorpusPaths> {
  const projectRoot = mkdtempSync(join(tmpdir(), "mneme-map-store-project-"));
  const corpusHome = mkdtempSync(join(tmpdir(), "mneme-map-store-home-"));
  return resolveCorpus(projectRoot, { corpusHome, clock: fixedClock });
}

function section(frontmatter: Partial<MapSectionFrontmatter> & { id: string }, body: string): MapSection {
  return {
    frontmatter: {
      kind: "domain",
      anchors: [],
      depends_on: [],
      terms: [],
      commit: "abc1234",
      ...frontmatter,
    },
    body,
  };
}

const billing = section(
  { id: "billing", anchors: ["src/billing/invoice.ts"], terms: ["invoice", "ledger"] },
  "Billing issues invoices.\nEvery order closes with one.",
);
const orders = section(
  { id: "orders", anchors: ["src/orders/order.ts"], terms: ["cart", "invoice"] },
  "Orders are placed by customers.",
);
const orderToInvoice = section(
  { id: "order-to-invoice", kind: "flow", depends_on: ["orders", "billing"], terms: ["checkout"] },
  "An order becomes an invoice.\nFirst the cart, then the ledger.",
);

describe("section files", () => {
  test("a domain lives under map/domains and a flow under map/flows, named by id", async () => {
    const corpus = await provisionedCorpus();

    expect(sectionPath(corpus, "domain", "billing")).toBe(join(corpus.mapDomainsDir, "billing.md"));
    expect(sectionPath(corpus, "flow", "order-to-invoice")).toBe(join(corpus.mapFlowsDir, "order-to-invoice.md"));
  });

  test("written sections read back domains first, then flows, each sorted by id", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, orderToInvoice);
    writeMapSection(corpus, orders);
    writeMapSection(corpus, billing);

    expect(readMapSections(corpus)).toEqual([billing, orders, orderToInvoice]);
    expect(readFileSync(sectionPath(corpus, "domain", "billing"), "utf8")).toBe(serializeMapSection(billing));
  });

  test("writing a section again replaces it in place", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, billing);
    const replaced = section({ id: "billing", terms: ["invoice"] }, "Billing, rewritten.");

    writeMapSection(corpus, replaced);

    expect(readMapSections(corpus)).toEqual([replaced]);
  });

  test("removing a section deletes its file; removing a missing one throws", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, billing);

    removeMapSection(corpus, "domain", "billing");

    expect(existsSync(sectionPath(corpus, "domain", "billing"))).toBe(false);
    expect(() => removeMapSection(corpus, "domain", "billing")).toThrow();
  });

  test("a corpus without a map directory reads as an empty map", () => {
    const corpus = corpusPaths(mkdtempSync(join(tmpdir(), "mneme-map-store-bare-")));

    expect(readMapSections(corpus)).toEqual([]);
  });

  test("a file whose frontmatter id disagrees with its name is a named error, never skipped", async () => {
    const corpus = await provisionedCorpus();
    writeFileSync(join(corpus.mapDomainsDir, "payments.md"), serializeMapSection(billing));

    expect(() => readMapSections(corpus)).toThrow(MapSectionValidationError);
    expect(() => readMapSections(corpus)).toThrow('declares id "billing", expected "payments"');
  });

  test("a domain file placed in the flows directory is a named error", async () => {
    const corpus = await provisionedCorpus();
    writeFileSync(join(corpus.mapFlowsDir, "billing.md"), serializeMapSection(billing));

    expect(() => readMapSections(corpus)).toThrow('declares kind "domain" but lives in the flow directory');
  });

  test("an unparseable file fails the whole read", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, billing);
    writeFileSync(join(corpus.mapDomainsDir, "broken.md"), "not a section at all\n");

    expect(() => readMapSections(corpus)).toThrow(MapSectionValidationError);
  });

  test("one id held by both kinds fails the read, naming both files", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, billing);
    writeMapSection(corpus, section({ id: "billing", kind: "flow" }, "A flow under a domain's id."));

    expect(() => readMapSections(corpus)).toThrow(MapSectionValidationError);
    expect(() => readMapSections(corpus)).toThrow(
      `map section id "billing" is held by both ${sectionPath(corpus, "domain", "billing")} and ` +
        `${sectionPath(corpus, "flow", "billing")}; delete it with map_delete and put it back as one kind`,
    );
  });

  test("listing names every section file by kind and id without reading it, so a broken file still lists", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, orderToInvoice);
    writeFileSync(join(corpus.mapDomainsDir, "broken.md"), "not a section at all\n");

    expect(listSectionFiles(corpus)).toEqual([
      { path: sectionPath(corpus, "domain", "broken"), kind: "domain", id: "broken" },
      { path: sectionPath(corpus, "flow", "order-to-invoice"), kind: "flow", id: "order-to-invoice" },
    ]);
    expect(readSectionFiles(listSectionFiles(corpus).filter((file) => file.id !== "broken"))).toEqual([orderToInvoice]);
  });

  test("files without the .md extension are ignored", async () => {
    const corpus = await provisionedCorpus();
    writeMapSection(corpus, billing);
    writeFileSync(join(corpus.mapDomainsDir, "billing.md.bak"), "scratch\n");
    mkdirSync(join(corpus.mapDomainsDir, "nested"));

    expect(readMapSections(corpus)).toEqual([billing]);
    rmSync(join(corpus.mapDomainsDir, "nested"), { recursive: true });
  });
});

describe("derived files", () => {
  test("an empty map renders a heading-only INDEX.md and a header-only glossary", () => {
    expect(renderMapIndex([])).toBe("# Project map\n");
    expect(renderGlossary([])).toBe("| term | domain |\n| --- | --- |\n");
    expect(MAP_INDEX_HEADING).toBe("# Project map");
  });

  test("INDEX.md lists one line per domain by id with the body's first line; flows are absent", () => {
    expect(renderMapIndex([orderToInvoice, orders, billing])).toBe(
      ["# Project map", "", "- billing — Billing issues invoices.", "- orders — Orders are placed by customers.", ""].join("\n"),
    );
  });

  test("glossary rows come from domain terms only, sorted by term then domain, a shared term twice", () => {
    expect(renderGlossary([orderToInvoice, orders, billing])).toBe(
      [
        "| term | domain |",
        "| --- | --- |",
        "| cart | orders |",
        "| invoice | billing |",
        "| invoice | orders |",
        "| ledger | billing |",
        "",
      ].join("\n"),
    );
  });

  test("a pipe inside a term is escaped so the table keeps its columns", () => {
    const piped = section({ id: "ops", terms: ["a|b"] }, "Ops.");

    expect(renderGlossary([piped])).toBe("| term | domain |\n| --- | --- |\n| a\\|b | ops |\n");
  });

  test("writeDerivedFiles writes both files into map/", async () => {
    const corpus = await provisionedCorpus();

    writeDerivedFiles(corpus, [billing, orders]);

    expect(readFileSync(corpus.mapIndexPath, "utf8")).toBe(renderMapIndex([billing, orders]));
    expect(readFileSync(corpus.glossaryPath, "utf8")).toBe(renderGlossary([billing, orders]));
  });

  test("rendering is deterministic regardless of input order", () => {
    expect(renderMapIndex([billing, orders])).toBe(renderMapIndex([orders, billing]));
    expect(renderGlossary([billing, orders])).toBe(renderGlossary([orders, billing]));
  });
});

describe("dangling dependencies", () => {
  test("a dependency on a section that exists is not dangling", () => {
    expect(findDanglingDependencies([billing, orders, orderToInvoice])).toEqual([]);
  });

  test("a dependency on a missing section is reported with the section that names it", () => {
    expect(findDanglingDependencies([billing, orderToInvoice])).toEqual([
      { id: "order-to-invoice", kind: "flow", missing: ["orders"] },
    ]);
  });

  test("a domain may depend on another domain and be reported the same way", () => {
    const payments = section({ id: "payments", depends_on: ["billing", "ledger"] }, "Payments.");

    expect(findDanglingDependencies([payments])).toEqual([
      { id: "payments", kind: "domain", missing: ["billing", "ledger"] },
    ]);
  });
});
