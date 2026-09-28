/** Verifies assumptions about the real ETAPI that the domain layer depends on. */
import { beforeAll, describe, expect, it } from 'vitest';
import { quote } from '../../src/domain/query/builder.js';
import { EtapiError } from '../../src/etapi/errors.js';
import { connectLive, unique, type LiveTrilium } from './helpers.js';

let live: LiveTrilium;
let folderId: string;
let noteId: string;

beforeAll(async () => {
  live = connectLive();
  const folder = await live.client.createNote({
    parentNoteId: 'root',
    title: unique('itest-folder'),
    type: 'book',
    content: '',
  });
  folderId = folder.note.noteId;
  const note = await live.client.createNote({
    parentNoteId: folderId,
    title: "Bob's Note",
    type: 'text',
    content: '<p>hello docker</p>',
  });
  noteId = note.note.noteId;
  await live.client.createAttribute({ noteId, type: 'label', name: 'status', value: 'todo' });
});

describe('live ETAPI behaviour', () => {
  it('reports app info', async () => {
    const info = await live.client.getAppInfo();
    expect(info.appVersion).toMatch(/^\d+\.\d+/);
  });

  it('search: fulltext, label, OR group with ~ prefix, quoting, hierarchy, params', async () => {
    const byText = await live.client.searchNotes({ search: 'docker', ancestorNoteId: folderId });
    expect(byText.results.map((n) => n.noteId)).toEqual([noteId]);
    const byLabel = await live.client.searchNotes({
      search: "#status = 'todo'",
      ancestorNoteId: folderId,
    });
    expect(byLabel.results.map((n) => n.noteId)).toEqual([noteId]);
    const orGroup = await live.client.searchNotes({
      search: '~(#status OR #nonexistent)',
      ancestorNoteId: folderId,
    });
    expect(orGroup.results.map((n) => n.noteId)).toEqual([noteId]);
    const quoted = await live.client.searchNotes({
      search: `note.title = ${quote("Bob's Note")}`,
      ancestorNoteId: folderId,
    });
    expect(quoted.results.map((n) => n.noteId)).toEqual([noteId]);
    const children = await live.client.searchNotes({
      search: `note.parents.noteId = ${quote(folderId)}`,
    });
    expect(children.results.map((n) => n.noteId)).toEqual([noteId]);
    const smart = await live.client.searchNotes({
      search: 'note.dateCreated >= TODAY-1',
      ancestorNoteId: folderId,
      limit: 1,
    });
    expect(smart.results).toHaveLength(1);
    // ancestorNoteId includes the ancestor itself; the labelled note must be absent.
    const notExists = await live.client.searchNotes({
      search: '#!status',
      ancestorNoteId: folderId,
    });
    expect(notExists.results.map((n) => n.noteId)).not.toContain(noteId);
  });

  it('search: the orderBy parameter sorts (always descending); an in-query orderBy clause is ignored', async () => {
    await live.client.createNote({
      parentNoteId: folderId,
      title: 'Aardvark',
      type: 'text',
      content: '',
    });
    const base = `note.parents.noteId = ${quote(folderId)}`;
    const param = await live.client.searchNotes({
      search: base,
      orderBy: 'title',
      orderDirection: 'asc',
    });
    expect(param.results.at(-1)?.title).toBe('Aardvark');
    const clause = await live.client.searchNotes({ search: `${base} orderBy note.title desc` });
    expect(clause.results.map((n) => n.title)).toEqual(
      [...clause.results.map((n) => n.title)].sort(),
    );
  });

  it('childNoteIds follow tree position and notePosition 0 inserts first', async () => {
    const first = await live.client.createNote({
      parentNoteId: folderId,
      title: 'Zero',
      type: 'text',
      content: '',
      notePosition: 0,
    });
    const folder = await live.client.getNote(folderId);
    expect(folder.childNoteIds[0]).toBe(first.note.noteId);
  });

  it('content PUT changes blobId; revisions can be created', async () => {
    const before = await live.client.getNote(noteId);
    await live.client.createRevision(noteId, 'itest');
    await live.client.putNoteContent(noteId, '<p>changed</p>');
    const after = await live.client.getNote(noteId);
    expect(after.blobId).not.toBe(before.blobId);
    expect(await live.client.getNoteContent(noteId)).toBe('<p>changed</p>');
  });

  it('attribute PATCH cannot retarget a relation, and inherited attributes carry the owner id', async () => {
    const rel = await live.client.createAttribute({
      noteId,
      type: 'relation',
      name: 'related',
      value: folderId,
    });
    await expect(
      live.client.patchAttribute(rel.attributeId, { value: noteId }),
    ).rejects.toMatchObject({ status: 400, code: 'PROPERTY_NOT_ALLOWED' });
    await live.client.createAttribute({
      noteId: folderId,
      type: 'label',
      name: 'inherited',
      value: 'x',
      isInheritable: true,
    });
    const note = await live.client.getNote(noteId);
    const inherited = note.attributes.find((a) => a.name === 'inherited');
    expect(inherited?.noteId).toBe(folderId);
  });

  it('404s are normalised', async () => {
    const err = await live.client.getNote('doesNotExist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtapiError);
    expect((err as EtapiError).code).toBe('NOTE_NOT_FOUND');
  });
});
