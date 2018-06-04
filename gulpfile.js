const path = require('path');
const gulp = require('gulp');
const ts = require('gulp-typescript');
const sourcemaps = require('gulp-sourcemaps');

function tsForTarget(target) {
  return () => {
    const tsProject = ts.createProject('tsconfig.json', {
      target,
    });
    return tsProject
      .src()
      .pipe(tsProject())
      .pipe(sourcemaps.init())
      .pipe(sourcemaps.write())
      .pipe(gulp.dest(`${target}`));
  };
}

gulp.task('es5', tsForTarget('es5'));
gulp.task('esnext', tsForTarget('esnext'));

gulp.task('default', ['es5', 'esnext']);
