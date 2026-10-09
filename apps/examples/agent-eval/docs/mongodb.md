# MongoDB case catalog

MongoDB stores **both single-turn and full-task cases**, plus module metadata. SQLite continues to store settings, evaluation batches, execution snapshots and results. CLI JSON suites still work as before. Nothing migrates automatically.

The Web service uses the official MongoDB **6.21.0** driver with Bun 1.3.13. Driver 7.7.0/BSON 7 currently invokes an unsupported Bun V8 API, so do not upgrade without testing the Bun runtime.

## Prepare a replica set

Transactions require a replica set or sharded deployment. A standalone `mongod` is rejected at startup. For local development:

```sh
docker run -d --name eval-mongo -p 127.0.0.1:27017:27017 \
  mongo:8.0 --replSet rs0 --bind_ip_all
docker exec eval-mongo mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

Use addresses reachable by the application for production replica-set members. Supply production credentials through server environment variables, never through browser fields or committed files.

Run the following from `apps/examples/agent-eval`:

```sh
export EVAL_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0'
export EVAL_MONGODB_DATABASE=agent_eval
export EVAL_MONGODB_CASE_COLLECTION=agent_eval_cases
export EVAL_MONGODB_MODULE_COLLECTION=agent_eval_modules
bun run mongo:prepare
```

`mongo:prepare` explicitly creates/updates validators and indexes. It does not rewrite existing documents. Duplicate names may prevent unique-index creation; fix conflicts before proceeding. Existing incompatible documents must be fixed to the contract; they will produce a clear document error when read. `mongo:prepare --seed-modules` additionally creates the four default modules only in an empty catalog. When migrating an existing SQLite catalog, **do not seed modules first**, as newly generated UUIDs would conflict with the original module names.

Use a preparation account with `createCollection`, `collMod` and index permissions. The application account needs read/write and transaction access to the two prepared collections, plus catalog/index inspection for startup checks; it does not create collections or install indexes. Use the same database and collection names for the application and external generator. The database is one evaluation catalog; separate environments should use separate databases, with their own module UUIDs.

## Start the Web UI

```sh
export EVAL_CASE_STORAGE=mongodb
export EVAL_DATA_DIR=/absolute/path/eval-history
bun run web
```

`EVAL_DATA_DIR/eval.sqlite` holds history and settings even in MongoDB mode. Keep the original history directory during migration to preserve history links. MongoDB startup validates deployment, collection validators and indexes. Reads always use MongoDB. Connection failures return 503 and never switch to an old SQLite copy. The history list, run details, exports and snapshot reruns remain independent of MongoDB when the running service loses its connection.

To keep an existing SQLite-only deployment, leave `EVAL_CASE_STORAGE` unset or set it to `sqlite`. Switching back does **not** copy MongoDB edits back into SQLite; that would require a separate migration, so do not use it as a failure fallback.

## Document contract

See [mongo-schema.ts](../src/web/mongo-schema.ts) for executable validators, indexes and API mappings. See [mongodb-case.example.json](mongodb-case.example.json) for a document using MongoDB Extended JSON dates. It is **not a CLI suite**: replace both UUID placeholders and model settings, then decode the Extended JSON dates before insertion. In mongosh, `EJSON.parse(...)` converts `$date` to BSON dates. In a driver, construct `Date` objects or use its EJSON decoder. Do not store the literal `$date` objects or date strings.

Cases use `_id` as the stable internal string UUID, `definition.id` as a module-local business name, `schemaVersion: 1`, positive integer `revision`, explicit boolean `archived`, BSON `createdAt`/`updatedAt`, and complete `definition`/`defaults` objects. `definition.replayMode` is explicitly `single-turn` or `full-task`. API responses map `_id` to `id` and dates to ISO strings. Optional fields must be omitted rather than set to null. Mongo credentials and resolved model credential values are never part of the case document.

Modules contain `_id`, `name`, `nameKey` (`name.trim().toLowerCase()`), `description`, `tags`, `archived`, BSON `createdAt`, and positive `writeVersion`. Names are limited to 80 characters; modules have at most 20 tags. `GET /api/modules` supplies active module UUIDs for an external generator.

Active module names and active business case names within each module have partial unique indexes. Archiving frees a name; restoring an archived item can fail with 409 if another active item occupies it. Module restore does not restore its archived cases. Archive operations increment case revisions to invalidate stale edit windows. Extra root metadata such as `provenance` is preserved when the app edits a case and when it copies one. Execution results belong to SQLite snapshots, not the current MongoDB case.

## External generation and editing

The simplest external writer uses the app's `POST /api/cases` or `PUT /api/cases/:id`, which enforces the same contract and MongoDB transactions. The application sees cases written directly into the prepared collections on its next read, without import or restart.

A direct database writer must cooperate with the app:

1. Build a complete document using the validator and current module UUID. A new document uses a new UUID, revision 1 and `archived: false`; single-turn history is context and prompt is the final question. The app still disables tools and generates one model response for single-turn cases.
2. Use a MongoDB transaction. Verify source/target modules are active and increment their `writeVersion` in stable UUID order. This conflicts with concurrent module archive rather than allowing a case to appear inside an archived module.
3. Update with `_id` **and expected revision**; increment `revision`, update `updatedAt`, and abort if no document matched. Keep `createdAt` and extra metadata. Do not write null for absent optional fields.
4. Do not overwrite whole collections or bypass validators. A writer that ignores revisions or module coordination cannot receive the application's concurrency guarantees.

The current schema supports `history[].role` of user/assistant and plain text content. Additional conversation formats require an explicit adapter rather than guessing field meanings.

## Migrate SQLite modules and cases

Stop application and external catalog writers during the cutover. Back up `eval.sqlite` consistently (SQLite backup API or a stopped database, including pending WAL changes), and retain run directories.

Prepare an **empty** target catalog, then preview:

```sh
bun run mongo:migrate --sqlite /absolute/path/eval.sqlite
```

This is read-only and reports proposed created/skipped counts and conflicts. It preserves internal UUIDs, revisions, tags, configuration and archive flags, and fills in explicit replay mode/date fields. It does not touch settings, runs, items or SQLite source records; it does not mark queued history interrupted. Equivalent already migrated documents are skipped. Different documents with the same UUID or active name cause the migration to stop, never overwrite.

After reviewing a clean report:

```sh
bun run mongo:migrate --sqlite /absolute/path/eval.sqlite --apply
```

Module and case inserts commit in one MongoDB transaction. Restart with MongoDB mode and the original `EVAL_DATA_DIR`. Keep backups until the new deployment is verified. Migration re-runs are safe for unchanged documents; subsequent edits are reported as conflicts.

## Test

The Mongo integration suite uses a dedicated test replica set with test failpoints enabled and creates/drops uniquely named databases. **Do not point it at a production deployment.**

```sh
export EVAL_TEST_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=rs0'
bun run test:mongo
bun test
bun run typecheck
```

Use `mongod --setParameter enableTestCommands=1` only on the local test replica set. Tests exercise concurrency, transaction rollback after a write, commit retries, module archive races, migration, and history access during a closed Mongo connection. Without `EVAL_TEST_MONGODB_URI`, these integration tests are explicitly skipped.
