import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { readSource } from '../src/jobs/read-source.js';
import { ReaderError, type ReaderClient, type ReaderPage } from '../src/reader.js';
import { addFile, addWebsite, findSource, listDocuments } from '../src/sources.js';
import { createTestTeam, freshDb } from './helpers.js';

let db: Db;
const LONG = 'We ship to Canada in five business days, with tracking on every order and free returns.';

function fakeReader(result: ReaderPage[] | Error) {
  const calls: string[] = [];
  const reader: ReaderClient = {
    readWebsite: async url => {
      calls.push(`website ${url}`);
      if (result instanceof Error) throw result;
      return result;
    },
    readFile: async file => {
      calls.push(`file ${file.name} ${file.data.toString()}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { reader, calls };
}

beforeEach(async () => {
  db ??= await freshDb();
  await db.query('truncate agent.teams restart identity cascade');
});

afterAll(async () => {
  await db?.end();
});

describe('readSource', () => {
  it('saves the pages of a website, drops near-empty ones and asks for a sync', async () => {
    const { teamId } = await createTestTeam(db);
    const website = (await addWebsite(db, teamId, 'https://shop.example.com/'))!;
    const { reader, calls } = fakeReader([
      { url: 'https://shop.example.com/shipping', title: 'Shipping', markdown: LONG },
      { url: 'https://shop.example.com/login', title: 'Log in', markdown: 'Log in' },
    ]);
    const synced: number[] = [];

    await readSource({ db, reader, syncTeam: async id => void synced.push(id) }, website.id, false);

    expect(calls).toEqual(['website https://shop.example.com/']);
    expect(await findSource(db, website.id)).toMatchObject({ status: 'ready', pages: 1, error: null });
    expect((await listDocuments(db, teamId)).map(page => page.title)).toEqual(['Shipping']);
    expect(synced).toEqual([teamId]);
  });

  it('reads a file once and forgets its bytes', async () => {
    const { teamId } = await createTestTeam(db);
    const file = await addFile(db, teamId, { name: 'Shipping.pdf', type: 'application/pdf', data: Buffer.from('%PDF') });
    const { reader, calls } = fakeReader([{ url: null, title: 'Shipping', markdown: LONG }]);

    await readSource({ db, reader, syncTeam: async () => undefined }, file.id, false);
    await readSource({ db, reader, syncTeam: async () => undefined }, file.id, false);

    expect(calls).toEqual(['file Shipping.pdf %PDF']);
    expect((await db.query('select file_data from agent.knowledge_sources')).rows[0].file_data).toBeNull();
  });

  it('shows a problem the team can fix, without retrying', async () => {
    const { teamId } = await createTestTeam(db);
    const website = (await addWebsite(db, teamId, 'http://10.0.0.1/'))!;
    const { reader } = fakeReader(new ReaderError("That address isn't a public website.", 422));

    await readSource({ db, reader, syncTeam: async () => undefined }, website.id, false);

    expect(await findSource(db, website.id)).toMatchObject({ status: 'failed', error: "That address isn't a public website." });
  });

  it('retries a reader outage, and keeps the last good pages when it gives up', async () => {
    const { teamId } = await createTestTeam(db);
    const website = (await addWebsite(db, teamId, 'https://shop.example.com/'))!;
    const good = fakeReader([{ url: 'https://shop.example.com/shipping', title: 'Shipping', markdown: LONG }]);
    await readSource({ db, reader: good.reader, syncTeam: async () => undefined }, website.id, false);
    const down = fakeReader(new ReaderError('The reader answered 503.', 503));

    await expect(readSource({ db, reader: down.reader, syncTeam: async () => undefined }, website.id, false)).rejects.toThrow('503');
    expect((await findSource(db, website.id))!.status).toBe('ready');
    await expect(readSource({ db, reader: down.reader, syncTeam: async () => undefined }, website.id, true)).rejects.toThrow('503');

    expect(await findSource(db, website.id)).toMatchObject({ status: 'failed', error: "Couldn't read this right now. Try again later." });
    expect((await listDocuments(db, teamId)).map(page => page.title)).toEqual(['Shipping']);
  });
});
