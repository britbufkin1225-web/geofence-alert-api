import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

const STATUS_LABELS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

/**
 * Catch-all exception filter that produces a stable, non-leaky JSON error
 * contract for every failure path:
 *
 *   { statusCode, error, message, path, timestamp }
 *
 * HttpExceptions (validation, not-found, conflict, ...) keep their status and
 * safe client-facing message. Any other error is reported as a generic 500 so
 * that stack traces, Prisma internals, SQL, filesystem paths, and secrets are
 * never exposed to clients. Unexpected errors are logged server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, error, message } = this.resolveError(exception);

    if (statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(body);
  }

  private resolveError(exception: unknown): {
    statusCode: number;
    error: string;
    message: string | string[];
  } {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      // Nest builds string payloads for simple exceptions and object payloads
      // (with a `message` array) for validation failures.
      if (typeof payload === 'string') {
        return {
          statusCode,
          error: this.statusLabel(statusCode),
          message: payload,
        };
      }

      const record = payload as {
        message?: string | string[];
        error?: string;
      };

      return {
        statusCode,
        error: record.error ?? this.statusLabel(statusCode),
        message: record.message ?? exception.message,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: this.statusLabel(HttpStatus.INTERNAL_SERVER_ERROR),
      message: 'Internal server error',
    };
  }

  private statusLabel(statusCode: number): string {
    return STATUS_LABELS[statusCode] ?? 'Error';
  }
}
