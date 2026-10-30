import { chat } from '../server/routes/chat.js'
import { generateImage } from '../server/routes/generate-image.js'

const chatResponse = await chat.request('/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ engine: 'diagram-design', messages: [{ role: 'user', content: 'test' }] }),
})
const imageResponse = await generateImage.request('/generate-image', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'test' }),
})

if (chatResponse.status !== 403 || imageResponse.status !== 403) {
  throw new Error(`Expected 403 responses, received chat=${chatResponse.status}, image=${imageResponse.status}`)
}
console.log('PASS: disabled Diagram+ and Image2 API requests return 403')
