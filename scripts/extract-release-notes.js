#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
const outputFile = process.argv[3];

function extractFromReleaseNotes(ver) {
  const filePath = path.resolve(__dirname, '../RELEASE_NOTES.md');
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const escaped = ver.replace(/\./g, '\\.');
  const regex = new RegExp('(?:^|\\n)## Version ' + escaped + '[\\s\\S]*?(?=\\n---\\s*\\n## Version |\\n## Version |$)');
  const match = content.match(regex);
  if (!match) return null;
  return match[0].trim().replace(/\n---\s*$/, '').trim();
}

function extractFromChangelog(ver) {
  const filePath = path.resolve(__dirname, '../CHANGELOG.md');
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const escaped = ver.replace(/\./g, '\\.');
  const regex = new RegExp('(?:^|\\n)## \\[' + escaped + '\\][\\s\\S]*?(?=\\n---\\s*\\n## \\[|\\n## \\[|$)');
  const match = content.match(regex);
  if (!match) return null;
  return match[0].trim().replace(/\n---\s*$/, '').trim();
}

let notes = extractFromReleaseNotes(version);
if (!notes) {
  notes = extractFromChangelog(version);
}
if (!notes) {
  notes = `## AWS Athena SQL Client v${version}\n\nAutomated release for version ${version}.`;
}

if (outputFile) {
  fs.writeFileSync(path.resolve(process.cwd(), outputFile), notes, 'utf8');
  console.log(`Release notes for v${version} written to ${outputFile}`);
} else {
  console.log(notes);
}
