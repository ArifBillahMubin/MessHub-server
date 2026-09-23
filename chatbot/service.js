const { SITE_CONTEXT, LINK_KEYS } = require('./context')

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n')
    .trim()
}

function parseReply(raw) {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
    const links = Array.isArray(parsed.links)
      ? parsed.links.filter((key) => LINK_KEYS.has(key))
      : []
    if (answer) return { answer, links }
  } catch {
    if (cleaned) return { answer: cleaned, links: [] }
  }
  return null
}

function toGeminiContents(message, history) {
  const contents = []
  if (Array.isArray(history)) {
    history.slice(-8).forEach((item) => {
      if (!item?.text) return
      const role = item.role === 'bot' ? 'model' : 'user'
      contents.push({
        role,
        parts: [{ text: String(item.text).slice(0, 1000) }],
      })
    })
  }
  contents.push({
    role: 'user',
    parts: [{ text: String(message).slice(0, 2000) }],
  })
  return contents
}

async function generateChatReply(message, history) {
  const apiKey = process.env.USER_GEMINI_API_KEY
  if (!apiKey) {
    const error = new Error(
      'Chat is not configured. Add USER_GEMINI_API_KEY to the server .env file.'
    )
    error.status = 503
    throw error
  }

  const model = process.env.USER_GEMINI_MODEL || 'gemini-2.0-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SITE_CONTEXT }],
      },
      contents: toGeminiContents(message, history),
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    }),
  })

  const data = await geminiRes.json()
  if (!geminiRes.ok) {
    const error = new Error(data?.error?.message || 'Gemini request failed.')
    error.status = 502
    throw error
  }

  const reply = parseReply(extractText(data))
  if (!reply) {
    const error = new Error('The assistant returned an empty reply.')
    error.status = 502
    throw error
  }

  return reply
}

module.exports = { generateChatReply }
