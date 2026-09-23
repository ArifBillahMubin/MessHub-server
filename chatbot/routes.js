const express = require('express')
const { handleChatbot } = require('./controller')

const router = express.Router()

router.post('/', handleChatbot)

module.exports = router
