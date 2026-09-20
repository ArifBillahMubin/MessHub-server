const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion } = require('mongodb')
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {

    const db = client.db('messHub')
    const userCollections = db.collection('users')
    const messCollections = db.collection('messes')
    const messMemberCollections = db.collection('messMembers')



    //save user in db 
    //

    try {
      await userCollections.createIndex({ email: 1 }, { unique: true })
      console.log('Unique index on email ensured.')
    } catch (indexErr) {
      console.warn('Could not create email index (non-fatal):', indexErr.message)
    }

    // Unique index on messCode — prevents duplicate codes at DB level
    try {
      await messCollections.createIndex({ messCode: 1 }, { unique: true })
      console.log('Unique index on messCode ensured.')
    } catch (indexErr) {
      console.warn('Could not create messCode index (non-fatal):', indexErr.message)
    }

    //  Mess Code Generator 
    // Format: MH + 6 uppercase alphanumeric chars, excluding confusing chars (I O 0 1)
    const SAFE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const generateMessCode = () => {
      let code = 'MH'
      for (let i = 0; i < 6; i++) {
        code += SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]
      }
      return code
    }

    // Generates a unique messCode that does not already exist in the DB
    const generateUniqueMessCode = async () => {
      let code
      let attempts = 0
      do {
        code = generateMessCode()
        attempts++
        if (attempts > 20) throw new Error('Could not generate a unique mess code.')
        const existing = await messCollections.findOne({ messCode: code })
        if (!existing) break
      } while (true)
      return code
    }

    //  POST /messes 
    // Creates a new mess, a messMembers record (role: manager), and sets hasMess=true on the user.
    app.post('/messes', async (req, res) => {
      const { email, name, description, location, maxMembers } = req.body

      // Basic validation
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      if (!name?.trim()) return res.status(400).send({ message: 'Mess name is required.' })
      if (!location?.address?.trim()) return res.status(400).send({ message: 'Location address is required.' })
      if (location?.latitude == null || location?.longitude == null) {
        return res.status(400).send({ message: 'Latitude and longitude are required.' })
      }
      if (!maxMembers || Number(maxMembers) < 1) {
        return res.status(400).send({ message: 'Maximum members must be a positive number.' })
      }

      // Resolve the user document from their email
      const creator = await userCollections.findOne({ email })
      if (!creator) return res.status(404).send({ message: 'User not found.' })

      // Prevent creating multiple messes when hasMess is already true
      if (creator.hasMess) {
        return res.status(409).send({ message: 'You already have a mess.' })
      }

      try {
        const messCode = await generateUniqueMessCode()
        const now = new Date()

        // 1. Create the mess document
        const newMess = {
          name: name.trim(),
          messCode,
          description: description?.trim() || '',
          location: {
            address: location.address?.trim() || '',
            area: location.area?.trim() || '',
            city: location.city?.trim() || '',
            cityCorporation: location.cityCorporation?.trim() || '',
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
          },
          maxMembers: Number(maxMembers),
          createdBy: creator._id,
          status: 'active',
          settings: {
            mealSystem: 'equal',
            expenseSplit: 'equal',
            currency: 'BDT',
            timezone: 'Asia/Dhaka',
          },
          recruitment: {
            isPublic: false,
            acceptingMembers: false,
          },
          createdAt: now,
          updatedAt: now,
        }

        const messResult = await messCollections.insertOne(newMess)
        const messId = messResult.insertedId

        // 2. Create messMembers record — creator becomes manager
        const memberRecord = {
          userId: creator._id,
          messId,
          role: 'manager',
          status: 'active',
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        }
        await messMemberCollections.insertOne(memberRecord)

        // 3. Mark user as having a mess
        await userCollections.updateOne(
          { _id: creator._id },
          { $set: { hasMess: true, updatedAt: now } }
        )

        return res.status(201).send({
          success: true,
          message: 'Mess created successfully.',
          messId: messId.toString(),
          messCode,
          name: newMess.name,
        })
      } catch (err) {
        console.error('Error creating mess:', err)
        // Handle duplicate messCode collision (shouldn't happen with generateUniqueMessCode but safety net)
        if (err.code === 11000) {
          return res.status(500).send({ message: 'Failed to generate unique mess code. Please try again.' })
        }
        return res.status(500).send({ message: 'Internal server error.' })
      }
    })

    // create a new user only if the email does not already exist
    app.post('/users', async (req, res) => {
      const { email, name, photoURL, phone, location, status, bio } = req.body

      if (!email) {
        return res.status(400).send({ message: 'Email is required.' })
      }

      // Check whether this email already has a MongoDB 
      const existingUser = await userCollections.findOne({ email })

      if (existingUser) {
        // User already exists
        return res.status(200).send({
          inserted: false,
          message: 'User already exists.',
          user: existingUser,
        })
      }

      // New user
      const now = new Date()
      const newUser = {
        email,
        name: name || '',
        photoURL: photoURL || '',
        phone: phone || '',
        location: location || '',
        status: status || '',
        bio: bio || '',
        role: 'member',
        hasMess: false,
        accountStatus: 'active',
        createdAt: now,
        updatedAt: now,
      }

      try {
        const result = await userCollections.insertOne(newUser)
        return res.status(201).send({
          inserted: true,
          message: 'User created successfully.',
          insertedId: result.insertedId,
        })
      } catch (err) {
        // Handle rare race-condition duplicate-key error from the unique index
        if (err.code === 11000) {
          const existing = await userCollections.findOne({ email })
          return res.status(200).send({
            inserted: false,
            message: 'User already exists.',
            user: existing,
          })
        }
        console.error('Error creating user:', err)
        return res.status(500).send({ message: 'Internal server error.' })
      }
    })

    // GET /users/mess-role — returns the user's effective role in their active mess
    // Returns { messRole: "manager" | "member" | null }
    // null means the user has no active messMembers record (hasMess is false or no record yet)
    app.get('/users/mess-role', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })

      // No mess at all — short-circuit
      if (!user.hasMess) return res.send({ messRole: null })

      // Find the most recent active membership record for this user
      const membership = await messMemberCollections.findOne(
        { userId: user._id, status: 'active' },
        { sort: { joinedAt: -1 } }
      )

      res.send({ messRole: membership?.role ?? null })
    })

    // GET /user/role — returns the user's global account role (member / super_admin)
    app.get('/user/role', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })
      res.send({ role: user.role || 'member' })
    })

    // GET /users/me 
    app.get('/users/me', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })
      res.send(user)
    })





    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
