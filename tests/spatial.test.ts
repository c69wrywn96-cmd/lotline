/**
 * ADR-0004 (horizontal), ADR-0005 (chainage) and ADR-0018 (vertical).
 *
 * Getting a datum or an MGA zone wrong puts a lot 1.8 m out of position, which in
 * this industry is a defect, not a rounding error.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb } from './helpers.js';

afterAll(async () => { await appDb.end(); });

describe('horizontal framework', () => {
  it('the project MGA zone and SRID cannot disagree', async () => {
    await expect(
      asOwner(async (c) => {
        const client = (await c.query(`SELECT id FROM organisation WHERE org_type='client' LIMIT 1`)).rows[0].id;
        const vd = (await c.query(`SELECT id FROM vertical_datum WHERE code='AHD71'`)).rows[0].id;
        // Zone 56 with zone 55's SRID: the classic silent 1.8 km error.
        return c.query(
          `INSERT INTO project (name, code, client_org_id, mga_zone, project_srid, default_vertical_datum_id)
           VALUES ('Bad CRS','BADCRS',$1,56,7855,$2)`,
          [client, vd],
        );
      }),
    ).rejects.toThrow(/mga_zone_matches_srid/);
  });

  it('canonical geometry is GDA2020 geographic and strictly 2D', async () => {
    const cols = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT f_table_name, f_geometry_column, srid, type, coord_dimension
             FROM geometry_columns WHERE f_table_schema='public' ORDER BY 1,2`,
        )
      ).rows,
    );
    expect(cols.length).toBeGreaterThan(0);
    for (const col of cols) {
      expect(col.srid, `${col.f_table_name}.${col.f_geometry_column}`).toBe(7844);
    }
    // The alignment centreline is the one measured geometry: M carries chainage.
    const aln = cols.find((c) => c.f_table_name === 'alignment');
    expect(aln.type).toBe('LINESTRINGM');
    // No geometry column anywhere carries Z — height lives in a named-datum
    // attribute, never in the geometry (ADR-0018).
    for (const col of cols) {
      expect(String(col.type), `${col.f_table_name} must not be 3D`).not.toMatch(/Z$|ZM$/);
    }
  });

  it('areas are computed in the project MGA zone, not on the spheroid', async () => {
    // A 100 m x 100 m parcel in MGA56 must measure ~10,000 m2 when transformed
    // back through the canonical 7844 storage. Anything else means the pipeline
    // is measuring in degrees or on a mismatched datum.
    const row = await asOwner(async (c) =>
      (
        await c.query(`
          WITH parcel AS (
            SELECT ST_Transform(
              ST_GeomFromText(
                'POLYGON((300000 6250000, 300100 6250000, 300100 6250100, 300000 6250100, 300000 6250000))',
                7856), 7844) AS g
          )
          SELECT ST_Area(ST_Transform(g, 7856)) AS area_m2 FROM parcel`)
      ).rows[0],
    );
    expect(Number(row.area_m2)).toBeGreaterThan(9999);
    expect(Number(row.area_m2)).toBeLessThan(10001);
  });
});

describe('chainage (ADR-0005)', () => {
  it('resolves a chainage to a coordinate on the alignment', async () => {
    const row = await asOwner(async (c) =>
      (
        await c.query(`
          SELECT ST_X(p) x, ST_Y(p) y
            FROM (SELECT chainage_to_point(
                    (SELECT id FROM alignment WHERE name = 'Mulgoa Road Mainline MC01'),
                    800) p) t`)
      ).rows[0],
    );
    // CH 800 is the second vertex of the seeded alignment.
    expect(Number(row.x)).toBeCloseTo(150.6905, 4);
    expect(Number(row.y)).toBeCloseTo(-33.765, 4);
  });

  it('applies chainage equations — the seeded alignment jumps 40 m at CH 1800', async () => {
    const [before, after] = await asOwner(async (c) => {
      const aln = (await c.query(`SELECT id FROM alignment WHERE name='Mulgoa Road Mainline MC01'`)).rows[0].id;
      const b = (await c.query(`SELECT ST_Y(chainage_to_point($1, 1700)) y`, [aln])).rows[0].y;
      const a = (await c.query(`SELECT ST_Y(chainage_to_point($1, 1900)) y`, [aln])).rows[0].y;
      return [Number(b), Number(a)];
    });

    // Downstream of the equation, CH 1900 resolves to measure 1860. Without the
    // equation it would resolve 40 m further along — which is how lots end up in
    // the wrong place after a re-design that did not re-chainage.
    const naive = await asOwner(async (c) =>
      Number(
        (
          await c.query(`
            SELECT ST_Y(ST_GeometryN(ST_LocateAlong(centreline, 1900),1)) y
              FROM alignment WHERE name='Mulgoa Road Mainline MC01'`)
        ).rows[0].y,
      ),
    );
    expect(after).not.toBeCloseTo(naive, 8);
    expect(before).toBeLessThan(0); // sanity: southern hemisphere
  });

  it('refuses a chainage outside the alignment extent rather than extrapolating', async () => {
    await expect(
      asOwner(async (c) => {
        const aln = (await c.query(`SELECT id FROM alignment WHERE name='Mulgoa Road Mainline MC01'`)).rows[0].id;
        return c.query(`SELECT chainage_to_point($1, 9999)`, [aln]);
      }),
    ).rejects.toThrow(/LOTLINE_CHAINAGE_OUT_OF_RANGE/);
  });
});

describe('vertical datum (ADR-0018)', () => {
  it('ships AHD71 and AHD-TAS83 as system reference datums', async () => {
    const rows = await asOwner(async (c) =>
      (await c.query(`SELECT code FROM vertical_datum WHERE project_id IS NULL ORDER BY code`)).rows,
    );
    expect(rows.map((r) => r.code)).toEqual(['AHD71', 'AHD_TAS83']);
  });

  it('a local datum must name the benchmark it is tied to', async () => {
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO vertical_datum (project_id, code, name, is_local)
           VALUES ($1,'SITE_LOCAL','Unnamed site datum', true)`,
          [proj],
        ),
      ),
    ).rejects.toThrow(/local_datum_has_origin/);
  });

  it('the project default seeds new records but never interprets a stored RL', async () => {
    // Asserted structurally: the column exists and is NOT NULL on project, and
    // no RL-bearing table resolves its datum through it. Domain B has no RL
    // columns yet; this test pins the invariant so Phase 2 cannot regress it.
    const col = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_name='project' AND column_name='default_vertical_datum_id'`,
        )
      ).rows[0],
    );
    expect(col.is_nullable).toBe('NO');

    const rlColumns = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema='public' AND column_name ~ '_rl_m$'`,
        )
      ).rows,
    );
    // Every RL column that exists must sit beside a vertical_datum_id on the
    // same table. Phase 2 adds the first ones; this guard is live from now.
    for (const rl of rlColumns) {
      const sibling = await asOwner(async (c) =>
        (
          await c.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name=$1 AND column_name='vertical_datum_id'`,
            [rl.table_name],
          )
        ).rowCount,
      );
      expect(sibling, `${rl.table_name}.${rl.column_name} has no vertical_datum_id`).toBe(1);
    }
  });
});

describe('ltree scope containment', () => {
  it('zone paths reflect the nesting', async () => {
    const rows = await asOwner(async (c) =>
      (await c.query(`SELECT code, path::text FROM zone ORDER BY path`)).rows,
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r.path]));
    expect(byCode.Z3).toBe('North.Z3');
    expect(byCode.Z5).toBe('South.Z5');
  });

  it('re-parenting a zone rewrites the whole subtree and resyncs the grants', async () => {
    // This is the defect 0010 fixed: AFTER UPDATE OF path never fired, so
    // descendants and access_grant.scope_path silently went stale.
    await asOwner(async (c) => {
      await c.query(
        `UPDATE zone SET parent_zone_id = (SELECT id FROM zone WHERE code='South')
          WHERE code = 'Z3'`,
      );
    });

    const moved = await asOwner(async (c) =>
      (await c.query(`SELECT path::text FROM zone WHERE code='Z3'`)).rows[0].path,
    );
    expect(moved).toBe('South.Z3');

    const grant = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT scope_path::text FROM access_grant
            WHERE scope_type='zone' AND scope_id=(SELECT id FROM zone WHERE code='Z3') LIMIT 1`,
        )
      ).rows[0].scope_path,
    );
    expect(grant, 'the write grant must follow the zone it names').toBe('South.Z3');

    // restore
    await asOwner(async (c) => {
      await c.query(
        `UPDATE zone SET parent_zone_id = (SELECT id FROM zone WHERE code='North') WHERE code='Z3'`,
      );
    });
  });

  it('a zone cannot be re-parented beneath itself', async () => {
    await expect(
      asOwner(async (c) =>
        c.query(
          `UPDATE zone SET parent_zone_id = (SELECT id FROM zone WHERE code='Z3') WHERE code='North'`,
        ),
      ),
    ).rejects.toThrow(/LOTLINE_ZONE_CYCLE/);
  });

  it('WBS paths nest to arbitrary depth', async () => {
    const row = await asOwner(async (c) =>
      (await c.query(`SELECT path::text FROM wbs_element WHERE wbs_code='3.2.1.4'`)).rows[0],
    );
    expect(row.path).toBe('w3.w2.w1.w4');
  });
});
