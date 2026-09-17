#!/usr/bin/env node
// Offline study quiz generator.
// Runs entirely on-device via Tether's QVAC SDK: no API key, no server call,
// your notes never leave this machine.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadModel, unloadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_NOTES = path.join(__dirname, '..', 'notes', 'photosynthesis.txt')
const NUM_QUESTIONS = 3
const LETTERS = ['A', 'B', 'C', 'D']

const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: NUM_QUESTIONS,
      maxItems: NUM_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' } },
          correctIndex: { type: 'integer', minimum: 0, maximum: 3 }
        },
        required: ['question', 'options', 'correctIndex']
      }
    }
  },
  required: ['questions']
}

async function generateQuiz(modelId, notesText) {
  const run = completion({
    modelId,
    history: [
      {
        role: 'user',
        content:
          `Write ${NUM_QUESTIONS} multiple-choice quiz questions (4 options each) based only on these notes:\n\n${notesText}`
      }
    ],
    stream: false,
    responseFormat: { type: 'json_schema', json_schema: { name: 'quiz', schema: QUIZ_SCHEMA } }
  })
  const text = await run.text
  return JSON.parse(text).questions
}

function cleanText(text) {
  // Small local models sometimes echo the letter prefix or trailing
  // commentary into a field's own value; strip that leakage defensively.
  return text
    .replace(/^[A-D]\)\]?\s*/, '')
    .split(/\n|\{|"\s*Answer:/)[0]
    .trim()
}

// A single shared async iterator over stdin lines, so answers are consumed
// strictly in order — calling rl.question() repeatedly can drop lines that
// arrive in the same burst (piped input delivers all lines before the first
// question()'s one-time listener is even attached).
function makeAnswerReader(rl) {
  const it = rl[Symbol.asyncIterator]()
  return async (prompt) => {
    process.stdout.write(prompt)
    const { value, done } = await it.next()
    return done ? ':quit' : value
  }
}

async function main() {
  const notesPath = process.argv[2] || DEFAULT_NOTES
  const notesText = fs.readFileSync(notesPath, 'utf8')
  console.log(`▸ Notes: ${notesPath}${notesPath === DEFAULT_NOTES ? ' (bundled sample)' : ''}`)

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const line = `  loading quiz model ${p.percentage.toFixed(0)}%`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  try {
    console.log('▸ Generating quiz on-device...\n')
    const questions = await generateQuiz(modelId, notesText)

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const readAnswer = makeAnswerReader(rl)
    let score = 0

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const question = cleanText(q.question)
      const options = q.options.map(cleanText)

      console.log(`Q${i + 1}. ${question}`)
      options.forEach((opt, idx) => console.log(`   ${LETTERS[idx]}) ${opt}`))

      let answerIdx = -1
      while (answerIdx === -1) {
        const raw = (await readAnswer('   Your answer (A-D): ')).trim().toUpperCase()
        if (raw === ':QUIT') process.exit(0)
        answerIdx = LETTERS.indexOf(raw)
        if (answerIdx === -1) console.log('   Please answer with A, B, C, or D.')
      }

      if (answerIdx === q.correctIndex) {
        score++
        console.log('   ✓ Correct!\n')
      } else {
        console.log(`   ✗ Incorrect — correct answer was ${LETTERS[q.correctIndex]}) ${options[q.correctIndex]}\n`)
      }
    }

    rl.close()
    console.log(`Score: ${score}/${questions.length}`)
  } finally {
    await unloadModel({ modelId })
  }
}

main().catch((error) => {
  console.error('✖ Error:', error)
  process.exit(1)
})
