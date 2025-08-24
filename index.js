const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");

//load environment variable from .env file
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ✅ Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tpqgn1y.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const apartmentCollection = client
      .db("BMS_ApartmentDB")
      .collection("apartments");

    //users collection
    const usersCollection = client.db("BMS_ApartmentDB").collection("users");

    // ✅ agreements collection
    const agreementCollection = client
      .db("BMS_ApartmentDB")
      .collection("agreements");

    // ✅ NEW: Coupon collection initialization
    const couponCollection = client.db("BMS_ApartmentDB").collection("coupons");

    const paymentCollection = client
      .db("BMS_ApartmentDB")
      .collection("payments");
    //members collection
    const membersCollection = client
      .db("BMS_ApartmentDB")
      .collection("members");

    // Announcements collection
    const announcementsCollection = client
      .db("BMS_ApartmentDB")
      .collection("announcements");

    // get all pending agreement requests
    app.get("/agreements", async (req, res) => {
      const result = await agreementCollection
        .find({ status: "pending" })
        .toArray();
      res.send(result);
    });

    // Accept request
    app.patch("/agreements/accept/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };

      // 1. update agreement status
      const updateDoc = {
        $set: { status: "checked" },
      };
      const result = await agreementCollection.updateOne(filter, updateDoc);

      // 2. change user role to "member"
      const agreement = await agreementCollection.findOne(filter);
      if (agreement?.userEmail) {
        await usersCollection.updateOne(
          { email: agreement.userEmail },
          { $set: { role: "member" } }
        );
      }

      res.send(result);
    });

    // Reject request
    app.patch("/agreements/reject/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };

      // only change status, keep role same
      const updateDoc = {
        $set: { status: "checked" },
      };
      const result = await agreementCollection.updateOne(filter, updateDoc);

      res.send(result);
    });

    // get all announcements
    app.get("/announcements", async (req, res) => {
      const result = await announcementsCollection.find().toArray();
      res.send(result);
    });

    // GET: load members who are in pending status
    app.get("/members/pending", async (req, res) => {
      try {
        const pendingMembers = await membersCollection
          .find({ status: "pending" })
          .toArray();

        res.send({
          success: true,
          count: pendingMembers.length,
          data: pendingMembers,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch pending members",
          error: error.message,
        });
      }
    });

    // --------------------------------------------------------
    // ✅ Get : Get user role by email
    app.get("/user/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          // যদি ডাটাবেজে না মিলে তাহলে default role user হবে
          return res.send({ email, role: "user" });
        }

        res.send({ email: user.email, role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role:", error);
        res.status(500).send({ message: "Failed to get role" });
      }
    });
    //----------------------------------------------------------------------

    // ✅ Get : Get user role by email (user / admin / member)
    app.get("/user/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          // ডাটাবেজে না থাকলে default হবে "user"
          return res.send({ email, role: "user" });
        }

        // যদি user থাকে তাহলে তার role (user/admin/member যেটাই থাকুক) সেটাই return হবে
        res.send({ email: user.email, role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role:", error);
        res.status(500).send({ message: "Failed to get role" });
      }
    });

    // custom Middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // 🔍 Search user by email
    app.get("/users/search", async (req, res) => {
      const { email } = req.query;
      if (!email) {
        return res
          .status(400)
          .send({ success: false, message: "Email is required" });
      }

      try {
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res
            .status(404)
            .send({ success: false, message: "User not found" });
        }
        res.send({ success: true, data: user });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // 🔑 Make or Remove Admin
    app.patch("/users/:id", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;

      // 🛑 যদি role না আসে
      if (!role) {
        return res.status(400).send({ message: "Role is required" });
      }

      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch (error) {
        return res.status(400).send({ message: "Invalid user id" });
      }

      try {
        const result = await usersCollection.updateOne(
          { _id: objectId },
          { $set: { role: role } }
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "User not found or role already set" });
        }

        res.send(result);
      } catch (error) {
        console.error("PATCH /users/:id error:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // ✅ GET all coupons
    app.get("/coupons", async (req, res) => {
      try {
        const coupons = await couponCollection.find().toArray();
        res.send({
          success: true,
          data: coupons,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch coupons",
          error: error.message,
        });
      }
    });

    // ✅ GET: Get agreements of a particular user by email
    app.get("/agreements", async (req, res) => {
      try {
        const email = req.query.email;

        console.log(req.headers);

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email query parameter is required",
          });
        }

        // sort by latest (_id descending)
        const agreements = await agreementCollection
          .find({ userEmail: email })
          .sort({ _id: -1 })
          .toArray();

        res.send({
          success: true,
          count: agreements.length,
          data: agreements,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch agreements",
          error: error.message,
        });
      }
    });

    // ✅ GET: Get all agreements (sorted by latest)
    app.get("/agreements/all", verifyFBToken, async (req, res) => {
      try {
        const agreements = await agreementCollection
          .find()
          .sort({ _id: -1 }) // latest first
          .toArray();

        res.send({
          success: true,
          count: agreements.length,
          data: agreements,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch all agreements",
          error: error.message,
        });
      }
    });

    // ✅ GET: Get single agreement by ID
    app.get("/agreements/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid agreement ID",
          });
        }

        const query = { _id: new ObjectId(id) };
        const agreement = await agreementCollection.findOne(query);

        if (!agreement) {
          return res.status(404).send({
            success: false,
            message: "Agreement not found",
          });
        }

        res.send({
          success: true,
          data: agreement,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch agreement",
          error: error.message,
        });
      }
    });

    // get all members (all status)
    app.get("/members", async (req, res) => {
      try {
        const members = await membersCollection.find().toArray();
        res.send({ success: true, data: members });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    //post the membersCollection
    app.post("/members", async (req, res) => {
      try {
        const member = req.body;

        if (!member.name || !member.email) {
          return res.status(400).send({
            success: false,
            message: "Name and Email are required",
          });
        }

        const result = await membersCollection.insertOne(member);

        res.send({
          success: true,
          message: "Member added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to add member",
          error: error.message,
        });
      }
    });

    // post announcement
    app.post("/announcements", async (req, res) => {
      const announcement = req.body; // {title, description, date}
      announcement.date = new Date(); // extra: তারিখ সেভ করতে পারো
      const result = await announcementsCollection.insertOne(announcement);
      res.send(result);
    });

    app.post("/member", async (req, res) => {
      const member = req.body;
      member.status = "pending"; // ✅ নতুন member হলে default pending
      const result = await membersCollection.insertOne(member);
      res.send(result);
    });

    // PATCH: Update member status
    app.patch("/members/:id", async (req, res) => {
      try {
        console.log("🔹 Incoming PATCH request");
        console.log("Params:", req.params); // 👀 Check ID আসছে কি না
        console.log("Body:", req.body); // 👀 Check status আসছে কি না

        const id = req.params.id;
        const { status, email } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "❌ Invalid MongoDB ID",
          });
        }

        if (!status) {
          return res.status(400).send({
            success: false,
            message: "❌ Status field is missing in request body",
          });
        }

        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: { status } };

        const result = await membersCollection.updateOne(query, updateDoc);

        if (result.modifiedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "⚠️ Member not found or already updated",
          });
        }

        //update user role for accepting member

        if (status === "active") {
          const userQuery = { email };
          const userUpdatedDoc = {
            $set: {
              role: "member",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdatedDoc
          );
          console.log(roleResult.modifiedCount);
        }

        res.send({
          success: true,
          message: `✅ Member status updated to ${status}`,
        });
      } catch (error) {
        console.error("❌ Error in PATCH:", error.message);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // get all members
    app.get("/users/members", async (req, res) => {
      const members = await usersCollection.find({ role: "member" }).toArray();
      res.send(members);
    });

    // remove member (change role to user)
    app.patch("/users/remove-member/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { role: "user" },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ✅ POST: Add a new coupon
    app.post("/coupons", async (req, res) => {
      try {
        const { code, discount, description } = req.body;

        if (!code || !discount || !description) {
          return res.status(400).send({
            success: false,
            message: "Missing coupon fields",
          });
        }

        const newCoupon = {
          code,
          discount: Number(discount),
          description,
          createdAt: new Date(),
        };

        const result = await couponCollection.insertOne(newCoupon);

        res.send({
          success: true,
          message: "Coupon added successfully",
          data: result,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to add coupon",
          error: error.message,
        });
      }
    });

    const announcementCollection = client
      .db("BMS_ApartmentDB")
      .collection("announcements");

    const { ObjectId } = require("mongodb");

    // ✅ DELETE: Delete an agreement by id
    app.delete("/agreements/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid agreement ID",
          });
        }

        const query = { _id: new ObjectId(id) };
        const result = await agreementCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Agreement not found",
          });
        }

        res.send({
          success: true,
          message: "Agreement deleted successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to delete agreement",
          error: error.message,
        });
      }
    });

    // =========================
    // payment paid and save the history
    // =========================

    // get payment history by user email
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        console.log("decoded", req.decoded); // debug log

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email query parameter is required",
          });
        }

        const payments = await paymentCollection
          .find({ userEmail: email })
          .sort({ date: -1 })
          .toArray();

        res.send({
          success: true,
          count: payments.length,
          data: payments,
        });
      } catch (error) {
        console.error("Error in /payments:", error); // debug log
        res.status(500).send({
          success: false,
          message: "Failed to fetch user payments",
          error: error.message,
        });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const paymentData = req.body; // { agreementId/agreementsId, userEmail/email, amount, month, transactionId, ... }

        // 🔧 FIX: frontend agreementsId + email came and normalize
        const agreementId = paymentData.agreementId || paymentData.agreementsId; // <-- FIX
        const userEmail = paymentData.userEmail || paymentData.email; // <-- FIX

        console.log("Incoming Payment Data (normalized):", {
          agreementId,
          userEmail,
          amount: paymentData.amount,
          month: paymentData.month,
          transactionId: paymentData.transactionId,
          paymentMethod: paymentData.paymentMethod,
        });

        // 🔒 Validation ( useing normalized keys)
        if (!agreementId || !userEmail || !paymentData.amount) {
          return res.status(400).send({
            success: false,
            message: "Missing required payment fields",
          });
        }

        // 🔹 1. Update agreement status to "paid"
        const filter = { _id: new ObjectId(agreementId) };
        const updateAgreement = await agreementCollection.updateOne(filter, {
          $set: { status: "paid" },
        });

        if (updateAgreement.modifiedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Agreement not found or already paid",
          });
        }

        // 🔹 2. Insert payment history (standardized key names )
        const newPayment = {
          agreementId, // standardized
          userEmail, // standardized
          amount: Number(paymentData.amount),
          month: paymentData.month || null,
          transactionId: paymentData.transactionId,
          paymentMethod: paymentData.paymentMethod,
          date: new Date(), // auto timestamp
        };

        const result = await paymentCollection.insertOne(newPayment);

        res.send({
          success: true,
          message: "Payment successful & agreement marked as paid",
          paymentId: result.insertedId,
          insertedId: result.insertedId, // <-- check frontend insertedId compatible
          // (FIX)
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Payment failed",
          error: error.message,
        });
      }
    });

    // card payment
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body;

        if (!amount) {
          return res.status(400).send({ error: "Amount is required" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: parseInt(amount), // stripe amount always in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (err) {
        console.error("Error creating payment intent:", err.message);
        res.status(500).send({ error: err.message });
      }
    });

    // GET: fetch all announcements
    app.get("/announcements", async (req, res) => {
      try {
        const result = await announcementCollection.find().toArray();
        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to get announcements", error: err.message });
      }
    });

    // ✅ POST: Save user to database (if not exists)
    app.post("/users", async (req, res) => {
      try {
        const user = req.body; // { name, email, photoURL }

        if (!user.email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required" });
        }

        const query = { email: user.email };
        const existingUser = await usersCollection.findOne(query);

        if (existingUser) {
          return res.send({
            success: true,
            message: "User already exists",
            user: existingUser,
          });
        }

        // ✅ Added extra default fields (agreementAcceptDate & rentedApartment)
        const newUser = {
          name: user.name || "Anonymous",
          email: user.email,
          photoURL:
            user.photoURL || "https://i.ibb.co/2nqZQFz/default-avatar.png",
          role: "user",
          createdAt: new Date(),
          lastLogin: new Date(), // 👉 optional: track login time

          // ✅ Default values for normal user
          agreementAcceptDate: null,
          rentedApartment: {
            floor: null,
            block: null,
            roomNo: null,
          },
        };

        const result = await usersCollection.insertOne(newUser);

        res.send({
          success: true,
          message: "New user created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to save user",
          error: error.message,
        });
      }
    });

    // ✅ GET: Get user by email with role
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user) {
        return res
          .status(404)
          .send({ success: false, message: "User not found" });
      }
      res.send({ success: true, role: user.role });
    });

    // ✅ GET all apartments
    app.get("/apartments", async (req, res) => {
      try {
        const apartments = await apartmentCollection.find().toArray();
        res.send(apartments);
      } catch (error) {
        console.error("Failed to fetch apartments:", error);
        res.status(500).send({
          success: false,
          message: "Could not retrieve apartments",
          error: error.message,
        });
      }
    });

    // ✅ POST: Add new apartment
    app.post("/apartments", async (req, res) => {
      try {
        const apartmentData = req.body;

        if (
          !apartmentData.apartmentNo ||
          !apartmentData.floor ||
          !apartmentData.block ||
          !apartmentData.rent
        ) {
          return res.status(400).send({
            success: false,
            message: "Missing required apartment fields",
          });
        }

        if (!apartmentData.status) {
          apartmentData.status = "pending";
        }

        const result = await apartmentCollection.insertOne(apartmentData);
        res.send({
          success: true,
          message: "Apartment added successfully",
          data: result,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to insert apartment",
          error: error.message,
        });
      }
    });

    // ✅ POST: Add agreement
    app.post("/agreements", async (req, res) => {
      try {
        const agreementData = req.body;

        // 🔍 check duplicate: same userEmail + apartmentNo
        const exists = await agreementCollection.findOne({
          userEmail: agreementData.userEmail,
          apartmentNo: agreementData.apartmentNo,
        });

        if (exists) {
          return res.status(409).send({
            success: false,
            message: "User already applied for this apartment",
          });
        }

        // ✨ insert new agreement
        const result = await agreementCollection.insertOne(agreementData);
        res.send({
          success: true,
          message: "Agreement request submitted",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to create agreement",
          error: error.message,
        });
      }
    });

    // ✅ Connection check
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

// default route
app.get("/", (req, res) => {
  res.send("Welcome to BMS-hub Apartment Server!");
});

// listen
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
