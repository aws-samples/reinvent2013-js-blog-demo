(function() {

  // Setup basic AWS configuration
  AWS.config.update({
    region: appInfo.db.region,
    credentials: appInfo.db.readCredentials,
    logger: console
  });

  var md2html = Markdown.getSanitizingConverter();
  var articleOrder = {};
  var articleData = {};
  var adminLoggedIn = false;
  var adminCredentials = new AWS.WebIdentityCredentials({
    RoleArn: appInfo.admin.roleArn,
    ProviderId: appInfo.admin.providerId
  });

  // Setup some service objects
  var dbReader = new AWS.DynamoDB({params: {TableName: appInfo.db.tableName}});
  var dbWriter = new AWS.DynamoDB({
    params: {TableName: appInfo.db.tableName},
    credentials: adminCredentials
  });
  var s3Bucket = new AWS.S3({
    paramValidation: false,
    computeChecksums: false,
    params: {Bucket: appInfo.s3.bucket},
    region: appInfo.s3.region,
    credentials: adminCredentials
  });

  var articlePreview = loadArticleEditor();
  articlePreview.run();

  // Some DOM elements
  var articles = document.getElementById('articles');
  var articleTemplate = document.getElementById('article-template').innerHTML;
  var articleEditor = document.getElementById('article-editor');
  var articleBody = document.getElementById('wmd-input');
  var articleTitle = document.getElementById('article-title');
  var articleDate = document.getElementById('article-date');
  var articleAsset = document.getElementById('article-asset');
  var chooseImageButton = document.getElementById('wmd-image-button');
  var publishButton = document.getElementById('publish-button');
  var cancelPublishButton = document.getElementById('cancel-publish-button');
  var postButton = document.getElementById('new-post-button');
  var loginButton = document.getElementById('login-button');
  var body = document.getElementsByTagName('body')[0];

  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
               .toString(16)
               .substring(1);
  };

  function guid() {
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
           s4() + '-' + s4() + s4() + s4();
  }

  function uploadAsset() {
    var file = articleAsset.files[0];
    var ext = file.name.match(/\.[^\.]+$/)[0];
    if (file) {
      var params = {
        Key: appInfo.s3.prefix + guid() + ext,
        ContentType: file.type,
        Body: file,
        ACL: 'public-read'
      };

      s3Bucket.putObject(params, function (err, data) {
        if (err) {
          console.log("Error uploading asset to S3", err.message);
        } else {
          var url = '//' + appInfo.s3.bucket + '.s3.amazonaws.com/' + params.Key;
          articleBody.value += '\n\n![](' + url + ')\n\n';
        }
      });
    }
  }

  function publishArticle() {
    var slug = articleTitle.value.toLowerCase().replace(/[^a-z0-9]/ig, '-');
    var params = {
      Item: {
        type: {S: 'article'},
        publishDate: {N: articleDate.value || new Date().getTime().toString()},
        title: {S: articleTitle.value},
        body: {S: articleBody.value},
        slug: {S: slug}
      }
    };

    var slugElement = document.getElementById(slug);
    if (slugElement) {
      var titleEl = document.querySelector('#' + slug + ' .title');
      var bodyEl = document.querySelector('#' + slug + ' .body');
      titleEl.innerText = params.Item.title.S;
      bodyEl.innerHTML = md2html.makeHtml(params.Item.body.S);
      dbWriter.putItem(params).send();
    }
    else {
      dbWriter.putItem(params, loadArticles);
    }

    cacheArticle(params.Item);
    hideEditor();
  }

  function deleteArticle(article) {
    var params = {
      Key: {
        type: {S: 'article'},
        publishDate: {N: article.publishDate.getTime().toString()}
      }
    };
    dbWriter.deleteItem(params, loadArticles);
  }

  function cacheArticle(item) {
    var slug = item.slug.S;
    var timestamp = parseInt(item.publishDate.N);
    articleOrder[slug] = slug;
    articleData[slug] = {
      slug: slug,
      publishDate: new Date(timestamp),
      title: item.title.S,
      body: item.body.S
    };
  }

  function showEditor(article) {
    articleTitle.value = article.title ? article.title : '';
    articleDate.value = article.publishDate ? article.publishDate.getTime().toString() : '';
    articleBody.value = article.body ? article.body : '';
    articleEditor.style.display = 'block';
    articles.style.display = 'none';
    articlePreview.refreshPreview();
  }

  function hideEditor() {
    articleEditor.style.display = 'none';
    articles.style.display = 'block';
  }

  function loadArticleEditor() {
    return new Markdown.Editor(md2html);
  }

  function loadArticles() {
    articleOrder = {};
    articleData = {};

    // Clear div
    articles.innerHTML = '';

    var params = {
      Limit: 20,
      ScanIndexForward: false,
      KeyConditions: {
        type: {
          AttributeValueList: [{S: "article"}],
          ComparisonOperator: "EQ"
        },
        publishDate: {
          AttributeValueList: [{N: "0"}],
          ComparisonOperator: "GE"
        }
      }
    };

    dbReader.query(params).eachPage(function (err, data) {
      if (data) {
        for (var i = 0; i < data.Items.length; i++) {
          cacheArticle(data.Items[i]);
        }
        if (!this.hasNextPage()) renderArticles();
      }
    });
  }

  function renderArticles() {
    var articleOrderKeys = Object.keys(articleOrder);
    for (var i = 0; i < articleOrderKeys.length; i++) {
      var slug = articleOrderKeys[i];
      var data = AWS.util.copy(articleData[slug]);
      data.body = md2html.makeHtml(data.body);
      renderArticle(data);
    }

    var editLinks = document.querySelectorAll('article .edit-button');
    for (var i = 0; i < editLinks.length; i++) {
      editLinks[i].onclick = function() {
        showEditor(articleData[this.parentNode.parentNode.id]);
      };
    }

    var deleteLinks = document.querySelectorAll('article .delete-button');
    for (var i = 0; i < deleteLinks.length; i++) {
      deleteLinks[i].onclick = function() {
        deleteArticle(articleData[this.parentNode.parentNode.id]);
      };
    }
  }

  function renderArticle(article) {
    articles.innerHTML += articleTemplate.replace(/\{\{(.+?)\}\}/g, function (text) {
      return article[text.replace(/[{}]/g, '')];
    });
  }

  function adminLogin() {
    if (adminLoggedIn) { FB.logout(); }
    else { FB.login(); }
  }

  // Facebook login
  window.fbAsyncInit = function() {
    FB.init({appId: appInfo.admin.appId});

    FB.Event.subscribe('auth.authResponseChange', function(response) {
      if (response.status === 'connected') {
        adminCredentials.params.WebIdentityToken =
          response.authResponse.accessToken;
        adminCredentials.refresh(function (err) {
          if (err) {
            console.log("Error logging into application", err.message);
            body.className = '';
            loginButton.innerText = 'Login';
            adminLoggedIn = false;

          } else {
            console.log("Logged into application as administrator");
            body.className = 'admin-logged-in';
            loginButton.innerText = 'Logout';
            adminLoggedIn = true;
          }
        });
      } else {
        console.log("Logged out");
        body.className = '';
        loginButton.innerText = 'Login';
        adminLoggedIn = false;
      }
    });

    FB.getLoginStatus();
  };

  // Load the SDK asynchronously
  (function(d, s, id){
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) {return;}
    js = d.createElement(s); js.id = id;
    js.src = "//connect.facebook.net/en_US/all.js";
    fjs.parentNode.insertBefore(js, fjs);
  }(document, 'script', 'facebook-jssdk'));

  loadArticles();
  publishButton.addEventListener('click', publishArticle, false);
  cancelPublishButton.addEventListener('click', hideEditor, false);
  postButton.addEventListener('click', showEditor, false);
  loginButton.addEventListener('click', adminLogin, false);
  chooseImageButton.addEventListener('click', function() { articleAsset.click(); }, false);
  articleAsset.addEventListener('change', uploadAsset, false);
})();

