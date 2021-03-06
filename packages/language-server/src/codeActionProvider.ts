import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  CodeActionParams,
  CodeAction,
  Diagnostic,
  DiagnosticSeverity,
  CodeActionKind,
  Range,
} from 'vscode-languageserver'
import { getAllRelationNames } from './completion/completions'
import {
  convertDocumentTextToTrimmedLineArray,
  getBlockAtPosition,
} from './MessageHandler'
import levenshtein from 'js-levenshtein'

function getInsertRange(document: TextDocument): Range {
  // to insert text into a document create a range where start === end.
  const start = { line: document.lineCount, character: 0 }
  return { start, end: start }
}

/**
 * Given a name and a list of symbols whose names are *not* equal to the name, return a spelling suggestion if there is one that is close enough.
 * Names less than length 3 only check for case-insensitive equality, not levenshtein distance.
 *
 * If there is a candidate that's the same except for case, return that.
 * If there is a candidate that's within one edit of the name, return that.
 * Otherwise, return the candidate with the smallest Levenshtein distance,
 *    except for candidates:
 *      * With no name
 *      * Whose meaning doesn't match the `meaning` parameter.
 *      * Whose length differs from the target name by more than 0.34 of the length of the name.
 *      * Whose levenshtein distance is more than 0.4 of the length of the name
 *        (0.4 allows 1 substitution/transposition for every 5 characters,
 *         and 1 insertion/deletion at 3 characters)
 */
function getSpellingSuggestions(
  name: string,
  possibleSuggestions: string[],
): string | undefined {
  const maximumLengthDifference = Math.min(2, Math.floor(name.length * 0.34))
  let bestDistance = Math.floor(name.length * 0.4) + 1 // If the best result isn't better than this, don't bother.
  let bestCandidate: string | undefined
  let justCheckExactMatches = false
  const nameLowerCase = name.toLowerCase()
  for (const candidate of possibleSuggestions) {
    if (
      !(
        Math.abs(candidate.length - nameLowerCase.length) <=
        maximumLengthDifference
      )
    ) {
      continue
    }
    const candidateNameLowerCase = candidate.toLowerCase()
    if (candidateNameLowerCase === nameLowerCase) {
      return candidate
    }
    if (justCheckExactMatches) {
      continue
    }
    if (candidate.length < 3) {
      // Don't bother, user would have noticed a 2-character name having an extra character
      continue
    }
    // Only care about a result better than the best so far.
    const distance = levenshtein(nameLowerCase, candidateNameLowerCase)
    if (distance > bestDistance) {
      continue
    }
    if (distance < 3) {
      justCheckExactMatches = true
      bestCandidate = candidate
    } else {
      bestDistance = distance
      bestCandidate = candidate
    }
  }
  return bestCandidate
}

function removeTypeModifiers(
  hasTypeModifierArray: boolean,
  hasTypeModifierOptional: boolean,
  input: string,
): string {
  if (hasTypeModifierArray) return input.replace('[]', '')
  if (hasTypeModifierOptional) return input.replace('?', '')
  return input
}

function addTypeModifiers(
  hasTypeModifierArray: boolean,
  hasTypeModifierOptional: boolean,
  suggestion: string,
): string {
  if (hasTypeModifierArray) return `${suggestion}[]`
  if (hasTypeModifierOptional) return `${suggestion}?`
  return suggestion
}

export function quickFix(
  textDocument: TextDocument,
  params: CodeActionParams,
): CodeAction[] {
  const lines: string[] = convertDocumentTextToTrimmedLineArray(textDocument)
  const diagnostics: Diagnostic[] = params.context.diagnostics

  if (!diagnostics || diagnostics.length === 0) {
    return []
  }

  const codeActions: CodeAction[] = []

  for (const diag of diagnostics) {
    if (
      diag.severity === DiagnosticSeverity.Error &&
      diag.message.startsWith('Type') &&
      diag.message.includes(
        'is neither a built-in type, nor refers to another model, custom type, or enum.',
      )
    ) {
      let diagText = textDocument.getText(diag.range)
      const hasTypeModifierArray: boolean = diagText.endsWith('[]')
      const hasTypeModifierOptional: boolean = diagText.endsWith('?')
      diagText = removeTypeModifiers(
        hasTypeModifierArray,
        hasTypeModifierOptional,
        diagText,
      )
      const spellingSuggestion = getSpellingSuggestions(
        diagText,
        getAllRelationNames(lines),
      )
      if (spellingSuggestion) {
        codeActions.push({
          title: `Change spelling to '${spellingSuggestion}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit: {
            changes: {
              [params.textDocument.uri]: [
                {
                  range: diag.range,
                  newText: addTypeModifiers(
                    hasTypeModifierArray,
                    hasTypeModifierOptional,
                    spellingSuggestion,
                  ),
                },
              ],
            },
          },
        })
      }
      codeActions.push({
        title: `Create new model '${diagText}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: {
          changes: {
            [params.textDocument.uri]: [
              {
                range: getInsertRange(textDocument),
                newText: `\nmodel ${diagText} {\n\n}\n`,
              },
            ],
          },
        },
      })
      codeActions.push({
        title: `Create new enum '${diagText}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: {
          changes: {
            [params.textDocument.uri]: [
              {
                range: getInsertRange(textDocument),
                newText: `\nenum ${diagText} {\n\n}\n`,
              },
            ],
          },
        },
      })
    }
    if (
      diag.severity === DiagnosticSeverity.Error &&
      diag.message.includes(
        'corresponding feature flag is enabled. Please add this field in your datasource block',
      ) &&
      diag.message.includes('previewFeatures = ["nativeTypes"]')
    ) {
      // get datasource block
      const generatorStart = lines.filter(
        (l) => l.startsWith('generator') && l.includes('{'),
      )
      if (generatorStart.length !== 0) {
        const index = lines.indexOf(generatorStart[0])
        if (index !== -1) {
          const block = getBlockAtPosition(index, lines)
          if (block) {
            codeActions.push({
              title: "Add preview feature 'nativeTypes' to generator block.",
              kind: CodeActionKind.QuickFix,
              diagnostics: [diag],
              edit: {
                changes: {
                  [params.textDocument.uri]: [
                    {
                      range: {
                        start: { line: block.end.line, character: 0 },
                        end: {
                          line: block.end.line,
                          character: Number.MAX_VALUE,
                        },
                      },
                      newText: '  previewFeatures = ["nativeTypes"]\n}',
                    },
                  ],
                },
              },
            })
          } else {
            console.log(
              'Not showing a quick-fix for native Types, because generator block could not be found.',
            )
          }
        } else {
          console.log(
            'Not showing a quick-fix for native Types, because a generator could not be found in cashed schema.',
          )
        }
      } else {
        console.log(
          'Not showing a quick-fix for native Types, because a generator could not be found.',
        )
      }
    }
    if (
      diag.severity === DiagnosticSeverity.Warning &&
      diag.message.includes("property has been renamed to 'previewFeatures'")
    ) {
      codeActions.push({
        title: "Rename property to 'previewFeatures'",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        edit: {
          changes: {
            [params.textDocument.uri]: [
              {
                range: diag.range,
                newText: 'previewFeatures',
              },
            ],
          },
        },
      })
    }
    if (
      diag.severity === DiagnosticSeverity.Error &&
      diag.message.includes(
        'It does not start with any known Prisma schema keyword.',
      )
    ) {
      const diagText = textDocument.getText(diag.range).split(/\s/)
      if (diagText.length !== 0) {
        const spellingSuggestion = getSpellingSuggestions(diagText[0], [
          'model',
          'enum',
          'datasource',
          'generator',
        ])
        if (spellingSuggestion) {
          codeActions.push({
            title: `Change spelling to '${spellingSuggestion}'`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diag],
            edit: {
              changes: {
                [params.textDocument.uri]: [
                  {
                    range: {
                      start: diag.range.start,
                      end: {
                        line: diag.range.start.line,
                        character: diagText[0].length,
                      },
                    }, // the red squiggly lines start at the beginning of the blog and end at the end of the line, include e.g. 'mode nameOfBlock {' but
                    // we only want to replace e.g. 'mode' with 'model', not delete the whole line
                    newText: spellingSuggestion,
                  },
                ],
              },
            },
          })
        }
      }
    }
  }

  return codeActions
}
