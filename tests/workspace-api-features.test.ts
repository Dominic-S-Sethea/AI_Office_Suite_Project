import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { StudioDocument } from "@ai-office-suite/shared-contracts";
import { initializePostgreSqlSchema, PgliteDatabaseAdapter } from "@ai-office-suite/database";
import { hashPassword } from "@ai-office-suite/identity";
import { createApiApp } from "../apps/api/src/app.ts";

describe("Phase 3 — Workspace & API Features (Search/Pagination, Revision Diff & Data-Prep Stage/Profile)", () => {
  it("supports RLS-isolated document search with SQL wildcard escaping, language filtering, pagination, and block-level revision diff", async () => {
    process.env.NODE_ENV = "test";
    const db = new PgliteDatabaseAdapter();
    await initializePostgreSqlSchema(db);

    const tenantA = "aaaaaaaa-1111-4111-8111-111111111111";
    const wsA = "bbbbbbbb-1111-4111-8111-111111111111";
    const userA = "cccccccc-1111-4111-8111-111111111111";
    const viewerA = "dddddddd-1111-4111-8111-111111111111";
    const tenantB = "eeeeeeee-2222-4222-8222-222222222222";
    const wsB = "ffffffff-2222-4222-8222-222222222222";
    const userB = "99999999-2222-4222-8222-222222222222";

    const pwHash = await hashPassword("FeaturePass!2026");

    await db.query("INSERT INTO organizations (tenant_id, name, status) VALUES ($1, 'Alpha', 'active'), ($2, 'Beta', 'active')", [
      tenantA,
      tenantB,
    ]);
    await db.query("INSERT INTO workspaces (workspace_id, tenant_id, name) VALUES ($1, $2, 'HQ'), ($3, $4, 'HQ')", [
      wsA,
      tenantA,
      wsB,
      tenantB,
    ]);
    await db.query(
      "INSERT INTO users (user_id, email, password_hash, status) VALUES ($1, 'ed-a@org.kh', $4, 'active'), ($2, 'vw-a@org.kh', $4, 'active'), ($3, 'ed-b@org.kh', $4, 'active')",
      [userA, viewerA, userB, pwHash],
    );
    await db.query(
      "INSERT INTO memberships (tenant_id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'editor'), ($1, $2, $4, 'viewer'), ($5, $6, $7, 'editor')",
      [tenantA, wsA, userA, viewerA, tenantB, wsB, userB],
    );

    const app = createApiApp({ authMode: "jwt-pg", db, inMemory: true, rateLimit: { enabled: false } });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const login = async (email: string, tenantId: string, workspaceId: string): Promise<string> => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "FeaturePass!2026", tenantId, workspaceId }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { token: string };
        return body.token;
      };

      const tokenA = await login("ed-a@org.kh", tenantA, wsA);
      const tokenViewerA = await login("vw-a@org.kh", tenantA, wsA);
      const tokenB = await login("ed-b@org.kh", tenantB, wsB);

      // Create 3 documents in Tenant A and 1 matching title in Tenant B
      const createDoc = async (token: string, title: string, language: "en" | "km" | "bilingual"): Promise<StudioDocument> => {
        const res = await fetch(`${baseUrl}/api/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title, language }),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { document: StudioDocument }).document;
      };

      const doc1 = await createDoc(tokenA, "100%_Target Revenue Brief", "en");
      await createDoc(tokenA, "របាយការណ៍លក់ប្រចាំត្រីមាស", "km");
      await createDoc(tokenA, "Bilingual Operations Memo", "bilingual");
      await createDoc(tokenB, "100%_Target Secret Beta Doc", "en");

      // Wildcard escaping: searching literal "100%_" should match ONLY Tenant A's doc1 (NOT other docs and NOT Tenant B!)
      const searchRes = await fetch(`${baseUrl}/api/documents?q=${encodeURIComponent("100%_")}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(searchRes.status).toBe(200);
      const searchBody = (await searchRes.json()) as { documents: StudioDocument[]; total: number; limit: number; offset: number };
      expect(searchBody.total).toBe(1);
      expect(searchBody.documents).toHaveLength(1);
      expect(searchBody.documents[0]?.documentId).toBe(doc1.documentId);

      // Language filter + pagination
      const kmRes = await fetch(`${baseUrl}/api/documents?language=km`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const kmBody = (await kmRes.json()) as { documents: StudioDocument[]; total: number };
      expect(kmBody.total).toBe(1);
      expect(kmBody.documents[0]?.language).toBe("km");

      const pageRes = await fetch(`${baseUrl}/api/documents?limit=2&offset=1`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const pageBody = (await pageRes.json()) as { documents: StudioDocument[]; total: number; limit: number; offset: number };
      expect(pageBody.total).toBe(3);
      expect(pageBody.documents).toHaveLength(2);
      expect(pageBody.limit).toBe(2);
      expect(pageBody.offset).toBe(1);

      // Update doc1 to rev 2 (modify title, layout orientation, existing block + add Khmer paragraph)
      const updatedBlocks = [
        ...doc1.blocks.map((b, idx) =>
          idx === 0 && b.type === "heading"
            ? { ...b, runs: [{ text: "Updated Revenue Heading" }] }
            : b,
        ),
        {
          id: "blk_km_added",
          type: "paragraph" as const,
          runs: [{ text: "សេចក្តីសង្ខេបហិរញ្ញវត្ថុថ្មី" }],
        },
      ];
      const putRes = await fetch(`${baseUrl}/api/documents/${doc1.documentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          expectedRevision: 1,
          title: "100%_Target Revenue Brief (Final)",
          layout: { ...doc1.layout, orientation: "landscape" },
          blocks: updatedBlocks,
        }),
      });
      expect(putRes.status).toBe(200);

      // Revision diff rev 1 -> rev 2
      const diffRes = await fetch(`${baseUrl}/api/documents/${doc1.documentId}/versions/1/diff/2`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(diffRes.status).toBe(200);
      const diffBody = (await diffRes.json()) as {
        diff: {
          fromRevision: number;
          toRevision: number;
          metadataChanged: { titleChanged: boolean; layoutChanged: boolean };
          summary: { added: number; modified: number; removed: number };
          blocks: Array<{ blockId: string; changeType: string; afterText?: string }>;
        };
      };
      expect(diffBody.diff.fromRevision).toBe(1);
      expect(diffBody.diff.toRevision).toBe(2);
      expect(diffBody.diff.metadataChanged.titleChanged).toBe(true);
      expect(diffBody.diff.metadataChanged.layoutChanged).toBe(true);
      expect(diffBody.diff.summary.added).toBe(1);
      expect(diffBody.diff.summary.modified).toBe(1);
      expect(diffBody.diff.blocks.find((b) => b.blockId === "blk_km_added")?.afterText).toContain("សេចក្តីសង្ខេប");

      // Cross-tenant diff denied (RLS returns 404)
      const crossDiffRes = await fetch(`${baseUrl}/api/documents/${doc1.documentId}/versions/1/diff/2`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      expect(crossDiffRes.status).toBe(404);

      // Data-prep sandbox endpoint: unauthenticated -> 401, viewer -> 403, editor -> 200 with BigInt reconciliation
      const unauthDp = await fetch(`${baseUrl}/api/data-prep/stage-and-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "a.csv", csvText: "a,b\n1,2\n" }),
      });
      expect(unauthDp.status).toBe(401);

      const viewerDp = await fetch(`${baseUrl}/api/data-prep/stage-and-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenViewerA}` },
        body: JSON.stringify({ filename: "a.csv", csvText: "a,b\n1,2\n" }),
      });
      expect(viewerDp.status).toBe(403);

      const editorDp = await fetch(`${baseUrl}/api/data-prep/stage-and-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          filename: "khmer-sales.csv",
          csvText:
            'organization_id,invoice_id,line_number,currency,amount,email\n00042,INV-1,1,USD,"១០០.៥០ $",alice@org.kh\n00042,INV-2,1,KHR,"៤,០០០,០០០ ៛",bob@org.kh\n',
          steps: [
            { stepId: "s1", op: "normalize_khmer_numerals", params: { columns: ["amount"], stripCurrencySymbols: true } },
            { stepId: "s2", op: "quarantine_missing_required", params: { column: "amount" } },
            { stepId: "s3", op: "mask_pii_columns", params: { columns: ["email"], mode: "redact" } },
          ],
        }),
      });
      expect(editorDp.status).toBe(200);
      const dpBody = (await editorDp.json()) as {
        source: { acceptedRows: number };
        dryRun: {
          status: string;
          sampleRows: Array<Record<string, unknown>>;
          reconciliation: { passed: boolean; currencyTotals: Array<{ currency: string; preparedMinorUnits: string; unexplainedMinorUnits: string }> };
        };
      };
      expect(dpBody.source.acceptedRows).toBe(2);
      expect(dpBody.dryRun.status).toBe("certified");
      expect(dpBody.dryRun.reconciliation.passed).toBe(true);
      expect(dpBody.dryRun.reconciliation.currencyTotals.find((c) => c.currency === "USD")?.preparedMinorUnits).toBe("10050");
      expect(dpBody.dryRun.reconciliation.currencyTotals.find((c) => c.currency === "KHR")?.preparedMinorUnits).toBe("4000000");
      expect(dpBody.dryRun.sampleRows[0]?.email).toBe("a***@org.kh");

      // Duplicate CSV header rejected with 400
      const dupCsvRes = await fetch(`${baseUrl}/api/data-prep/stage-and-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ filename: "dup.csv", csvText: "id,amount,amount\n1,10,20\n" }),
      });
      expect(dupCsvRes.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });
});
