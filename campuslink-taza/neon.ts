import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,

  buckets: {
    uploads: { access: "private" },
  },

  branch: (branch) => {
    if (branch.isDefault) {
      return {};
    }

    if (!branch.exists) {
      return { ttl: "7d" };
    }

    return {};
  },
});
