import * as Joi from 'joi';

/**
 * Environment validation schema. Applied by ConfigModule at startup so the
 * application fails closed when authentication is misconfigured.
 *
 * `JWT_SECRET` is required with a minimum length so the app can never boot with
 * a missing or trivially weak signing key. There is no insecure production
 * fallback secret anywhere in the codebase. Unknown variables are allowed so
 * that unrelated existing configuration (API_PREFIX, LOG_LEVEL, ...) continues
 * to work.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().min(1).default('file:./dev.db'),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
}).unknown(true);
