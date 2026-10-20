import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class QueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  question: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  documentIds?: string[];
}
