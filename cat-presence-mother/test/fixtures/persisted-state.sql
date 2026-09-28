BEGIN TRANSACTION;
CREATE TABLE outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tag_id TEXT NOT NULL,
                episode INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                UNIQUE(tag_id, episode, kind)
            );
INSERT INTO "outbox" VALUES(2,'b',0,'absence','⚠ Cat B has not been detected for 1 h 1 min.
Last seen: never (timer starts at first service start).
Last RSSI: unknown.',0,0.0);
CREATE TABLE states (
                tag_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL,
                last_seen REAL, last_rssi INTEGER, alert_sent INTEGER NOT NULL DEFAULT 0,
                missing_since REAL, episode INTEGER NOT NULL DEFAULT 0
            );
INSERT INTO "states" VALUES('b','Cat B',0.0,NULL,NULL,0,0.0,0);
INSERT INTO "states" VALUES('a','Cat A',0.0,100.0,-63,1,100.0,0);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('outbox',2);
COMMIT;
