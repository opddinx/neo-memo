# Neo Memo Store contract

Neo Memo App and Neo Memo Store are physically independent. The app repository is
[`opddinx/neo-memo`](https://github.com/opddinx/neo-memo); personal data may be
kept in the private [`opddinx/neo-memo-data`](https://github.com/opddinx/neo-memo-data)
repository, but neither repository is required to be next to the other.

## Paths

The App never derives a Store path from its own path. CLI resolution is:

1. `--store <path>`
2. `NEO_MEMO_STORE`

If neither is supplied, the CLI exits with an error and does not create a folder.
The desktop app uses `NEO_MEMO_STORE` first when supplied, otherwise its persisted
app setting. With no saved Store it asks the user to open an existing Store or
explicitly initialize an empty folder.

The cache directory is separate from the Store. `MemoService` uses a configurable
cache path; absent a setting it uses an OS temporary-directory location keyed by
the absolute Store path. Locks and Git hook isolation are cache data, not Store
data. It is safe to delete that cache and reopen the Store.

## Canonical data

Every Store root contains this marker and canonical content:

```text
neo-memo-data/
├── neo-memo-store.json
├── items/
└── assets/
```

`neo-memo-store.json` is validated before opening a Store:

```json
{
  "format": "neo-memo-store",
  "schemaVersion": 1,
  "storeId": "persistent UUID"
}
```

`storeId` is created once during `init store` or v1 migration and is never
changed. Unknown format or schema versions are rejected.

Items are Markdown files with JSON/YAML-compatible frontmatter. Their `id` is a
URL-independent, immutable ULID-style identifier. URLs and X post IDs are used
only for duplicate detection. A future Store consumer must refer to an item by
this Item ID, not by its filename convention, URL, or App-relative path.

Assets are content addressed. An item exposes an asset identifier such as
`sha256:<hash>`; only the Store access layer resolves it to `assets/…`. Consumers
must not make a physical asset path part of their external contract.

The Store layer is exposed from `src/store/` and owns opening, validation,
initialization, migration, item operations, duplicate lookup, and asset
resolution. GUI, CLI, importers, and future MCP/Ideation consumers depend on this
boundary rather than parsing `items/*.md` independently.

## Git

Only the canonical Store data is eligible for the Store repository's automatic
commits: `neo-memo-store.json`, `items/`, `assets/`, and Store metadata.
Indexes, embeddings, previews generated as cache, temporary downloads, locks, and
Git hook working files are excluded because they are reconstructible.

Git itself is optional. A Store works as a completely local repository without an
`origin`; if a remote exists, the existing explicit `git-sync` operation uses it.
App-repository Git commands are never issued against the Store and vice versa.

## Initialization and migration

Create a Store only through an explicit operation:

```sh
neo-memo init store --store D:/data/neo-memo-data
```

To convert an existing v1 Store in place without deleting `items/` or `assets/`:

```sh
neo-memo migrate store --store D:/data/neo-memo-data
```

Migration adds `neo-memo-store.json`, preserves existing Item IDs and assets,
rewrites legacy `assets/<prefix>/<hash>.<ext>` references to `sha256:<hash>`, and
moves connector checkpoints from legacy `state/sources.json` to local cache state.
It never moves the Store relative to the App and never adds ideation fields.

## Future Ideation boundary

The Store holds captured source information, previews, summaries, tags, why-saved
notes, and memos. Ideation-specific entities—boards, canvas positions, clusters,
relations, layouts, and visualization state—do not belong here. A future Ideation
Store can reference an item with `{ "neoMemoItemId": "01K…" }`.
