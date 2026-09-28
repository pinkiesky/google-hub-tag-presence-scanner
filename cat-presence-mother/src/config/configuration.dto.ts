import { plainToInstance } from 'class-transformer';
import {
  Equals,
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export class ConfigurationDto {
  @IsObject()
  service!: Record<string, unknown>;

  // Validate entries separately so one invalid secret disables only its tag.
  @IsArray()
  tags!: unknown[];
}

export class SettingsDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  missingAfterSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(32)
  driftWindows!: number;

  @IsString()
  @Matches(/\S/)
  database!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsInt()
  @Min(1)
  @Max(65535)
  udpPort!: number;
}

export class TagIdentityDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/)
  id!: string;
}

export class TagEntryDto extends TagIdentityDto {
  @IsString()
  secret_file!: string;

  @IsInt()
  @Min(-(2 ** 32) + 1)
  @Max(2 ** 32 - 1)
  clock_offset_seconds!: number;
}

export class TagSecretDto {
  @Equals(1)
  version!: number;

  @IsString()
  // Preserve the existing UTF-16 length limit after the loader trims the name.
  @Matches(/^[\s\S]{1,128}(?![\s\S])/)
  name!: string;

  @IsInt()
  @Min(0)
  @Max(2 ** 40 - 1)
  pair_date!: number;

  @IsString()
  @Matches(/^[0-9a-fA-F]{64}(?![\s\S])/)
  eik_hex!: string;
}

/** Never expose validator errors containing configuration or secret contents. */
export function validateConfigurationDto<T extends object>(
  type: new () => T,
  value: Record<string, unknown>,
  message: string | Record<string, string>,
): T {
  const instance = plainToInstance(type, value, { enableImplicitConversion: false });
  const errors = validateSync(instance, {
    whitelist: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });

  if (errors.length) {
    throw new Error(
      typeof message === 'string'
        ? message
        : (message[errors[0].property] ?? 'Invalid configuration'),
    );
  }

  return instance;
}
