import { describe, expect, it } from 'vitest';
import { decodeNetscapeTag, parseNetscapeHtml } from './bookmarkParser';
import { nth } from '../test/assert';

// Firefox writes a folder description as a <DD> right after the <H3>; it holds the folder's <DL>.
const FIREFOX_FOLDER_DD = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><A HREF="https://a.example.com/" ADD_DATE="1700000000">A</A>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100">Klasör</H3>
    <DD>Folder description
    <DL><p>
        <DT><A HREF="https://b.example.com/">B</A>
        <DT><A HREF="https://c.example.com/">C</A>
    </DL><p>
    <DT><A HREF="https://d.example.com/">D</A>
</DL>`;

describe('parseNetscapeHtml: <DD> descriptions', () => {
  it('walks into a folder <DD> and keeps the folder contents (Firefox export)', async () => {
    const items = await parseNetscapeHtml(FIREFOX_FOLDER_DD);
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(items[0]?.folderPath).toEqual([]);
    expect(items[1]?.folderPath).toEqual(['Klasör']);
    expect(items[2]?.folderPath).toEqual(['Klasör']);
    expect(items[3]?.folderPath).toEqual([]);
  });

  it('never attaches a folder description to a bookmark', async () => {
    const items = await parseNetscapeHtml(FIREFOX_FOLDER_DD);
    expect(items[0]?.description).toBeUndefined();
    expect(items.every((i) => i.description === undefined)).toBe(true);
  });

  it('attaches a bookmark <DD> to that bookmark only, without nested titles', async () => {
    const html = `<DL><p>
      <DT><A HREF="https://a.example.com/">A</A>
      <DD>About A
      <DT><H3>Dev</H3>
      <DD>Dev folder
      <DL><p>
        <DT><A HREF="https://b.example.com/">B</A>
        <DD>About B
        <DT><A HREF="https://c.example.com/">C</A>
      </DL><p>
      <DT><A HREF="https://d.example.com/">D</A>
      <DD>About D
    </DL>`;
    const items = await parseNetscapeHtml(html);
    const byTitle = new Map(items.map((item) => [item.title, item]));
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(byTitle.get('A')?.description).toBe('About A');
    expect(byTitle.get('B')?.description).toBe('About B');
    expect(byTitle.get('B')?.folderPath).toEqual(['Dev']);
    expect(byTitle.get('C')?.description).toBeUndefined();
    expect(byTitle.get('D')?.description).toBe('About D');
    expect(byTitle.get('D')?.folderPath).toEqual([]);
  });
});

describe('parseNetscapeHtml: damaged and extended markup', () => {
  it('recovers the links inside an unclosed <H3> instead of returning nothing', async () => {
    const html = `<DL><p>
      <DT><H3>Broken
      <DL><p>
        <DT><A HREF="https://a.example.com/">A</A>
        <DT><A HREF="https://b.example.com/">B</A>
      </DL><p>
      <DT><A HREF="https://c.example.com/">C</A>
    </DL>`;
    const items = await parseNetscapeHtml(html);
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    expect(items[0]?.folderPath).toEqual(['Broken']);
    expect(items[1]?.folderPath).toEqual(['Broken']);
  });

  it('reads LAST_MODIFIED as updatedAt (seconds → ms)', async () => {
    const items = await parseNetscapeHtml(
      `<DL><DT><A HREF="https://a.example.com/" ADD_DATE="1700000000" LAST_MODIFIED="1700000500">A</A>
       <DT><A HREF="https://b.example.com/">B</A></DL>`,
    );
    expect(items[0]?.addedAt).toBe(1_700_000_000_000);
    expect(items[0]?.updatedAt).toBe(1_700_000_500_000);
    expect(items[1]?.updatedAt).toBeUndefined();
    expect('updatedAt' in nth(items, 1)).toBe(false);
  });

  it('splits TAGS on commas and decodes an escaped comma inside a tag', async () => {
    const [item] = await parseNetscapeHtml(
      `<DL><DT><A HREF="https://a.example.com/" TAGS="c%2C c++, rust ,,100%25">A</A></DL>`,
    );
    expect(item?.tags).toEqual(['c, c++', 'rust', '100%']);
  });

  it('decodeNetscapeTag only undoes the export escapes', () => {
    expect(decodeNetscapeTag('a%2Cb')).toBe('a,b');
    expect(decodeNetscapeTag('a%2cb')).toBe('a,b');
    expect(decodeNetscapeTag('100%25')).toBe('100%');
    // An escaped literal "%2C" stays "%2C".
    expect(decodeNetscapeTag('%252C')).toBe('%2C');
    expect(decodeNetscapeTag('plain')).toBe('plain');
  });
});

describe('parseNetscapeHtml: pathological nesting', () => {
  const nested = (depth: number) =>
    `<DL><p>${'<DT><H3>f</H3><DL><p>'.repeat(depth)}<DT><A HREF="https://a.example.com/">A</A>${'</DL>'.repeat(depth)}</DL>`;

  it('imports deeply nested folders up to the walker depth limit', async () => {
    const items = await parseNetscapeHtml(nested(31));
    expect(items[0]?.folderPath).toHaveLength(31);
  });

  it('stops instead of recursing without a bound', async () => {
    // One stack frame per element: this many nested <DL>s overflow it unless the branch is dropped.
    await expect(parseNetscapeHtml(nested(40))).resolves.toEqual([]);
  });
});
