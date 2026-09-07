import { customType } from 'drizzle-orm/pg-core';

/**
 * Types Postgres has and Drizzle does not. Each mirrors a column the migrations
 * define; the migrations remain authoritative (see scripts/migrate.ts).
 */

/** Case-insensitive text. Email identity must not fork on case. */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** Hierarchical label path, used for zone and WBS subtree scoping (ADR-0020). */
export const ltree = customType<{ data: string }>({
  dataType: () => 'ltree',
});

/**
 * Canonical geometry: GDA2020 geographic (EPSG:7844), 2D. Vertical position is
 * never carried here — it is an explicit attribute against a named datum
 * (ADR-0018).
 */
export const geometry = customType<{ data: string; driverData: string }>({
  dataType: (config) => {
    const c = config as { type?: string; srid?: number } | undefined;
    return `geometry(${c?.type ?? 'Geometry'}, ${c?.srid ?? 7844})`;
  },
});

/** Postgres range types. */
export const daterange = customType<{ data: string }>({ dataType: () => 'daterange' });
export const tstzrange = customType<{ data: string }>({ dataType: () => 'tstzrange' });
export const numrange = customType<{ data: string }>({ dataType: () => 'numrange' });

/** An interval, returned by the driver as a parsed object. */
export const interval = customType<{ data: string }>({ dataType: () => 'interval' });
