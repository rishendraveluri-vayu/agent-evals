-- A toolset's sha256 now covers its full published manifest (each allowed tool's name,
-- description and input schema, and the MCP server's version), not just the tool names, so a
-- tool schema change is a new toolset (4 Nov: sip_future_value's lump_sum). The manifest is
-- stored with it, so a past config's tools can be read back from its toolset row. Rows stored
-- before this change hashed the names only and have no manifest: NULL, never back-filled,
-- because their hash did not cover it.
ALTER TABLE toolsets ADD COLUMN manifest jsonb;
