import {
  Controller, Delete, Get, Param, ParseUUIDPipe, Post, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { config } from '../config';
import { AuthUser } from '../auth/auth.service';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IngestionQueue } from '../ingestion/ingestion.queue';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly queue: IngestionQueue) {}

  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
    }),
  )
  upload(@CurrentUser() user: AuthUser, @UploadedFiles() files: Express.Multer.File[]) {
    return this.docs.upload(user.id, files);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.docs.list(user.id);
  }

  @Get('queue/stats')
  stats() {
    return this.queue.stats();
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(user.id, id);
  }

  @Get(':id/chunks')
  chunks(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.chunks(user.id, id);
  }

  @Post(':id/reindex')
  reindex(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.reindex(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.remove(user.id, id);
  }
}
