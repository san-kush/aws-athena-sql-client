import * as vscode from 'vscode';

interface SqlStatement {
  range: vscode.Range;
  text: string;
}

/**
 * Parses a SQL document into individual statements separated by semicolons.
 * Returns the range and text of each statement.
 */
function parseSqlStatements(document: vscode.TextDocument): SqlStatement[] {
  const text = document.getText();
  const statements: SqlStatement[] = [];

  let statementStart = -1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Skip single-line comments
    if (ch === '-' && i + 1 < text.length && text[i + 1] === '-') {
      // Find start of statement if we haven't yet
      // (comments before a statement don't count as part of it)
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      i++; // skip newline
      continue;
    }

    // Skip block comments
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && i + 1 < text.length && text[i + 1] === '/')) {
        i++;
      }
      i += 2; // skip */
      continue;
    }

    // Skip string literals (single-quoted)
    if (ch === '\'') {
      if (statementStart === -1) {
        statementStart = i;
      }
      i++;
      while (i < text.length) {
        if (text[i] === '\'' && i + 1 < text.length && text[i + 1] === '\'') {
          i += 2; // escaped quote
        } else if (text[i] === '\'') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Skip double-quoted identifiers
    if (ch === '"') {
      if (statementStart === -1) {
        statementStart = i;
      }
      i++;
      while (i < text.length && text[i] !== '"') {
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    // Semicolon ends the statement
    if (ch === ';') {
      if (statementStart !== -1) {
        const stmtText = text.substring(statementStart, i + 1).trim();
        if (stmtText.length > 1) { // more than just ";"
          const startPos = document.positionAt(statementStart);
          const endPos = document.positionAt(i + 1);
          statements.push({ range: new vscode.Range(startPos, endPos), text: stmtText });
        }
      }
      statementStart = -1;
      i++;
      continue;
    }

    // Non-whitespace marks start of a statement
    if (statementStart === -1 && !/\s/.test(ch)) {
      statementStart = i;
    }

    i++;
  }

  // Handle last statement without trailing semicolon
  if (statementStart !== -1) {
    const stmtText = text.substring(statementStart).trim();
    if (stmtText.length > 0) {
      const startPos = document.positionAt(statementStart);
      const endPos = document.positionAt(text.length);
      statements.push({ range: new vscode.Range(startPos, endPos), text: stmtText });
    }
  }

  return statements;
}

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const statements = parseSqlStatements(document);

    for (const stmt of statements) {
      const codeLens = new vscode.CodeLens(stmt.range, {
        title: '▶ Run Query',
        command: 'athena.runQuery',
        arguments: [stmt.range]
      });
      codeLenses.push(codeLens);
    }

    return codeLenses;
  }
}
