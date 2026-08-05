import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Class-level validator that fails when the validated object contains no
 * defined properties. Used by update DTOs to reject empty request bodies
 * (`{}`) while still allowing valid partial updates.
 *
 * Unknown properties are stripped by the global ValidationPipe
 * (`whitelist` + `forbidNonWhitelisted`) before this runs, so a body that
 * contains only unknown fields is rejected earlier as a bad request.
 */
export function AtLeastOneField(
  validationOptions?: ValidationOptions,
): ClassDecorator {
  return (target) => {
    registerDecorator({
      name: 'atLeastOneField',
      // For a class decorator the target IS the class constructor.
      target,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const object = args.object as Record<string, unknown>;
          return Object.keys(object).some((key) => object[key] !== undefined);
        },
        defaultMessage(): string {
          return 'At least one updatable field must be provided';
        },
      },
    });
  };
}
