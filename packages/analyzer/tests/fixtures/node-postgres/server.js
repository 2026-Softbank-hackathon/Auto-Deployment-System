const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.get("/health", async (req, res) => {
  const port = process.env.PORT || 8080;
  res.json({ status: "ok", port });
});

app.listen(8080, () => {
  console.log("Server started");
});
