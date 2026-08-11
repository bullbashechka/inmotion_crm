if (process.env.TEST_DATABASE_URL === undefined || process.env.TEST_DATABASE_URL.trim() === "" || process.env.TEST_DATABASE_DISPOSABLE_CLUSTER !== "1") {
  throw new Error("TEST_DATABASE_URL and TEST_DATABASE_DISPOSABLE_CLUSTER=1 are required; tests alter cluster-global roles.");
}
