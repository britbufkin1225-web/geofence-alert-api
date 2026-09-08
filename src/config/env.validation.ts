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
 *
 * `DATABASE_URL` is required and must be a PostgreSQL connection string (GF-3).
 * It previously defaulted to a local SQLite file; a default is now deliberately
 * absent so a misconfigured environment fails at startup instead of quietly
 * pointing at the wrong database.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
}).unknown(true);
