import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Member {
  name: string;
  token: string;
  createdAt: string;
}

interface MembersFile {
  version: 1;
  members: Member[];
}

function membersPath(dir: string): string {
  return path.join(dir, "members.json");
}

export function loadMembers(dir: string): Member[] {
  const filename = membersPath(dir);
  if (!fs.existsSync(filename)) return [];
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<MembersFile>;
  return parsed.members ?? [];
}

function saveMembers(dir: string, members: Member[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = membersPath(dir);
  const temp = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, members }, null, 2)}\n`);
  fs.renameSync(temp, filename);
}

/** Mint a new member + ingest token, or return the existing member with that name. */
export function mintMember(dir: string, name: string): Member {
  const members = loadMembers(dir);
  const existing = members.find((member) => member.name === name);
  if (existing) return existing;
  const member: Member = {
    name,
    token: `gbird_${randomBytes(24).toString("base64url")}`,
    createdAt: new Date().toISOString(),
  };
  members.push(member);
  saveMembers(dir, members);
  return member;
}

export function memberByToken(dir: string, token: string): Member | null {
  if (!token) return null;
  return loadMembers(dir).find((member) => member.token === token) ?? null;
}
