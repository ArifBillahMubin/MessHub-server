const { generateChatReply } = require('./service')

async function handleChatbot(req, res) {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) {
    return res.status(400).send({ message: 'Message is required.' })
  }

  try {
    const reply = await generateChatReply(message, req.body?.history)
    return res.send(reply)
  } catch (err) {
    const status = err.status || 502
    return res.status(status).send({
      message: err.message || 'Could not reach the assistant. Try again.',
    })
  }
}

module.exports = { handleChatbot }
