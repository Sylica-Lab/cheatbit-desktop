const BUILT_IN_STRIPE_CONFIG = {
  publishableKey:
    "pk_test_51T8OU123aLW8QJ0LZ8VcNzEp380YDZ8RGUUs4rFZwcekiBPD0Hq2et0STk7Z1XSuURzSytYGcWZi1GLkFKLRxuzX00YiScEQWC",
  secretKey:
    "sk_test_51T8OU123aLW8QJ0LSruDVZTZ8IyoC1gPqwzEIPVTgUUgDmTNWgDUsZiDrMjsATElrO6RYQmGKJhRIGj9CJe2yA0g00pKkHGrqx",
  webhookSecret: "",
  priceId: "",
  productName: "Sylica AI Unlimited",
  monthlyPriceUsd: 20,
  publicUrl: "",
  billingReturnUrl: "",
};

function getBuiltInStripeConfig() {
  return {
    publishableKey: String(BUILT_IN_STRIPE_CONFIG.publishableKey || "").trim(),
    secretKey: String(BUILT_IN_STRIPE_CONFIG.secretKey || "").trim(),
    webhookSecret: String(BUILT_IN_STRIPE_CONFIG.webhookSecret || "").trim(),
    priceId: String(BUILT_IN_STRIPE_CONFIG.priceId || "").trim(),
    productName: String(BUILT_IN_STRIPE_CONFIG.productName || "").trim(),
    monthlyPriceUsd: BUILT_IN_STRIPE_CONFIG.monthlyPriceUsd,
    publicUrl: String(BUILT_IN_STRIPE_CONFIG.publicUrl || "").trim(),
    billingReturnUrl: String(BUILT_IN_STRIPE_CONFIG.billingReturnUrl || "").trim(),
  };
}

module.exports = {
  BUILT_IN_STRIPE_CONFIG,
  getBuiltInStripeConfig,
};
