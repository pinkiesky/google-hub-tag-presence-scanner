import { IsNumber, IsString, Matches, ValidateBy } from 'class-validator';

import { isFhnUuid } from '../fhn/fhn-parser.service';

export class ObservationDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/, {
    message: 'satelliteId must contain 1-64 letters, digits, underscores or hyphens',
  })
  satelliteId!: string;

  @ValidateBy({
    name: 'isFhnUuid',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isFhnUuid(value),
      defaultMessage: () => 'serviceUuid must be a FEAA service UUID',
    },
  })
  serviceUuid!: string;

  @IsString()
  @Matches(/^(?:[0-9a-fA-F]{2}){1,255}(?![\s\S])/, {
    message: 'serviceDataHex must encode 1-255 bytes as hexadecimal pairs',
  })
  serviceDataHex!: string;

  // Signal-range validation belongs to the observation pipeline: out-of-range
  // RSSI must still allow a cryptographically matched tag to update presence.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  rssi!: number;
}
